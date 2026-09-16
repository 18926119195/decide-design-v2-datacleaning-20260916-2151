# ============================================================
# push-to-github.ps1
# ------------------------------------------------------------
# 一键把当前目录推到 GitHub，使用 gh CLI。
# 本脚本是项目自带的——下次 clone 下来直接就能用，无需重新部署。
#
# 用法（在 PowerShell 中，本目录下）：
#   .\scripts\push-to-github.ps1
#
# 常用参数：
#   -Visibility public|private    默认 private
#   -Description  "desc"          默认读 package.json 的 description
#   -Message      "commit msg"    默认 "chore: sync from local"
#   -RepoName     <name>          默认用当前目录名
#   -Branch       <name>          默认 main
#   -Remote       <name>          默认 origin
#   -Force                       跳过确认
#   -NoCreate                    不自动创建远程仓库（只推到已有仓）
#   -DryRun                      只打印动作，不实际执行
# ============================================================

[CmdletBinding()]
param(
    [ValidateSet('public', 'private')]
    [string]$Visibility = 'private',

    [string]$Description = '',
    [string]$Message = 'chore: sync from local',
    [string]$RepoName = '',
    [string]$Branch = 'main',
    [string]$Remote = 'origin',
    [switch]$Force,
    [switch]$NoCreate,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------- 颜色辅助 ----------
function Write-Step { param($t) Write-Host ('[STEP] ' + $t) -ForegroundColor Cyan }
function Write-OK   { param($t) Write-Host ('[OK]   ' + $t) -ForegroundColor Green }
function Write-Warn { param($t) Write-Host ('[WARN] ' + $t) -ForegroundColor Yellow }
function Write-Err  { param($t) Write-Host ('[ERR]  ' + $t) -ForegroundColor Red }
function Write-Info { param($t) Write-Host ('[INFO] ' + $t) -ForegroundColor Gray }

# ---------- 0. 修正 PATH（处理非标准安装位置） ----------
$customPath = @(
    'C:\GitPortable\cmd',
    'C:\Program Files\GitHub CLI',
    'C:\Program Files (x86)\GitHub CLI',
    'C:\Program Files\Git',
    'C:\Program Files (x86)\Git\cmd'
) -join ';'
$env:PATH = $customPath + ';' + $env:PATH

# ---------- 1. 工具自检 ----------
function Assert-Tool {
    param([string]$Cmd, [string]$InstallHint)
    $found = Get-Command $Cmd -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Err ('not found: ' + $Cmd)
        Write-Info ('install: ' + $InstallHint)
        throw ('missing-tool:' + $Cmd)
    }
    return $found.Source
}

Write-Step 'checking environment'
$ghPath  = Assert-Tool 'gh'  'winget install --id GitHub.cli  or  https://cli.github.com/'
$gitPath = Assert-Tool 'git' 'https://git-scm.com/download/win'
Write-OK ('gh   -> ' + $ghPath)
Write-OK ('git  -> ' + $gitPath)

# ---------- 2. gh 登录态 ----------
Write-Step 'checking gh auth'
gh auth status 2>&1 | Out-Null
$authRc = $LASTEXITCODE
if ($authRc -ne 0) {
    Write-Warn 'gh not authenticated yet.'
    $doLogin = $Force.IsPresent
    if (-not $Force) {
        $ans = Read-Host 'login now? [Y/n]'
        if ($ans -eq '' -or $ans -match '^[Yy]') { $doLogin = $true }
    }
    if ($doLogin) {
        gh auth login
    } else {
        throw 'aborted: gh not authenticated'
    }
}

$whoami = gh api user --jq '.login' 2>$null
if ($LASTEXITCODE -eq 0 -and $whoami) {
    Write-OK ('logged in as: ' + $whoami)
} else {
    Write-Warn 'cannot read current user (continuing)'
}

# ---------- 3. 推导仓库名 / 描述 ----------
$projectRoot = (Resolve-Path .).Path
if (-not $RepoName) {
    $RepoName = Split-Path -Leaf $projectRoot
}
if (-not $Description) {
    $pkgJsonPath = Join-Path $projectRoot 'package.json'
    if (Test-Path $pkgJsonPath) {
        try {
            $pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
            if ($pkg.description) { $Description = [string]$pkg.description }
        } catch {
            # ignore JSON read failure, fall back to repo name
        }
    }
}
if (-not $Description) { $Description = $RepoName }

Write-Info ('repo:    ' + $RepoName)
Write-Info ('visibility: ' + $Visibility)
Write-Info ('desc:    ' + $Description)
Write-Info ('branch:  ' + $Branch)
Write-Info ('remote:  ' + $Remote)

# ---------- 4. git 初始化 ----------
Write-Step 'preparing local git'
if (-not (Test-Path '.git')) {
    Write-Info 'no .git found, initializing...'
    if (-not $DryRun) { git init -b $Branch | Out-Null }
    Write-OK 'git init done'
} else {
    Write-OK 'already a git repo'
}

# 设置本地用户身份（如果没设）
$cfgUser  = git config user.name
$cfgEmail = git config user.email
if (-not $cfgUser -or -not $cfgEmail) {
    Write-Warn 'git user.name / user.email not set, using placeholder.'
    if (-not $DryRun) {
        $placeholder = if ($whoami) { $whoami } else { 'github-user' }
        git config user.name  $placeholder
        $placeholderEmail = $placeholder + '@users.noreply.github.com'
        git config user.email $placeholderEmail
    }
}

# 当前分支
$currentBranch = git rev-parse --abbrev-ref HEAD 2>$null
if (-not $currentBranch) {
    if (-not $DryRun) {
        git checkout -b $Branch | Out-Null
    }
    $currentBranch = $Branch
}
Write-Info ('current branch: ' + $currentBranch)

# ---------- 5. 远程仓库 ----------
$remoteUrl = git remote get-url $Remote 2>$null
$repoExistsOnGithub = $false

if ($remoteUrl) {
    Write-OK ('remote configured: ' + $Remote + ' -> ' + $remoteUrl)
    gh repo view "$RepoName" --json name 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $repoExistsOnGithub = $true }
} else {
    gh repo view "$RepoName" --json name 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $repoExistsOnGithub = $true
        Write-Warn ('repo ' + $RepoName + ' already exists on GitHub, adding as remote.')
        $owner = gh repo view "$RepoName" --json owner --jq '.owner.login' 2>$null
        if (-not $owner) { $owner = $whoami }
        $sshUrl   = 'git@github.com:' + $owner + '/' + $RepoName + '.git'
        $httpsUrl = 'https://github.com/' + $owner + '/' + $RepoName + '.git'
        $chosen   = $httpsUrl
        if (-not $Force) {
            $ans = Read-Host 'choose remote protocol [1] https  [2] ssh  (default 1)'
            if ($ans -eq '2') { $chosen = $sshUrl }
        }
        if (-not $DryRun) {
            git remote add $Remote $chosen
        }
        Write-OK ('remote added: ' + $chosen)
    } else {
        if ($NoCreate) {
            Write-Err 'remote repo does not exist, and -NoCreate was given. exit.'
            throw 'no-remote-and-no-create'
        }
        Write-Step ('creating repo on GitHub: ' + $RepoName + ' (' + $Visibility + ')')
        if (-not $Force) {
            $ans = Read-Host 'confirm creation? [Y/n]'
            if ($ans -ne '' -and $ans -notmatch '^[Yy]') { throw 'aborted' }
        }
        if (-not $DryRun) {
            gh repo create $RepoName --$Visibility --description $Description --source . --remote $Remote --push 2>&1 | Write-Host
            if ($LASTEXITCODE -ne 0) {
                throw 'gh-repo-create-failed'
            }
        }
        Write-OK 'repo created and pushed'
    }
}

# ---------- 6. 暂存 / 提交 ----------
Write-Step 'staging and committing'
if (-not $DryRun) {
    git add -A
}

$status = git status --porcelain
if (-not $status) {
    Write-OK 'working tree clean, nothing to commit'
} else {
    $count = ($status | Measure-Object -Line).Lines
    Write-Info ('changes to commit: ' + $count)
    if (-not $DryRun) {
        git commit -m $Message | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'git-commit-failed' }
    }
    Write-OK ('committed: ' + $Message)
}

# ---------- 7. 推送 ----------
$remoteList = git remote 2>$null
$skipPush = (-not $repoExistsOnGithub) -and (-not $DryRun) -and ($Remote -notin $remoteList)

if ($skipPush) {
    Write-Info 'already pushed by `gh repo create --push`, skip.'
} else {
    Write-Step 'pushing to GitHub'
    if (-not $DryRun) {
        git push -u $Remote $currentBranch 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Warn 'push failed, trying pull --rebase then push...'
            git pull --rebase --autostash $Remote $currentBranch 2>&1 | Write-Host
            git push -u $Remote $currentBranch 2>&1 | Write-Host
            if ($LASTEXITCODE -ne 0) { throw 'git-push-failed' }
        }
    }
    Write-OK 'push complete'
}

# ---------- 8. 收尾 ----------
$repoUrl = gh repo view "$RepoName" --json url --jq '.url' 2>$null
Write-Host ''
Write-OK 'done.'
if ($repoUrl) {
    Write-Host ('  repo URL: ' + $repoUrl) -ForegroundColor Green
}
Write-Host ''
