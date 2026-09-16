#!/usr/bin/env bash
# ============================================================
# push-to-github.sh
# ------------------------------------------------------------
# 一键把当前目录推到 GitHub，使用 gh CLI。
# 跨平台：Linux / macOS / WSL / Git Bash 都可以跑。
# 本脚本是项目自带的——下次 clone 下来直接就能用，无需重新部署。
#
# 用法：
#   ./scripts/push-to-github.sh
#
# 常用参数（环境变量）：
#   VISIBILITY=public|private    默认 private
#   DESCRIPTION="一句话描述"     默认读 package.json 的 description
#   MESSAGE="提交说明"           默认 "chore: sync from local"
#   REPO_NAME=<name>             默认用当前目录名
#   BRANCH=<name>                默认 main
#   REMOTE=<name>                默认 origin
#   FORCE=1                      跳过确认
#   NO_CREATE=1                  不自动创建远程仓库
#   DRY_RUN=1                    只打印动作
# ============================================================

set -euo pipefail

VISIBILITY="${VISIBILITY:-private}"
DESCRIPTION="${DESCRIPTION:-}"
MESSAGE="${MESSAGE:-chore: sync from local}"
REPO_NAME="${REPO_NAME:-}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
FORCE="${FORCE:-}"
NO_CREATE="${NO_CREATE:-}"
DRY_RUN="${DRY_RUN:-}"

# ---------- 颜色 ----------
if [[ -t 1 ]]; then
  C_STEP=$'\e[36m'; C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_OFF=$'\e[0m'
else
  C_STEP=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
step() { echo "${C_STEP}▶ $*${C_OFF}"; }
ok()   { echo "${C_OK}✔ $*${C_OFF}"; }
warn() { echo "${C_WARN}⚠ $*${C_OFF}"; }
err()  { echo "${C_ERR}✖ $*${C_OFF}"; }
info() { echo "  $*"; }

# ---------- 1. 工具自检 ----------
assert_tool() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "未找到 $cmd。"
    info "安装方式：$hint"
    exit 2
  fi
}

step "检查环境…"
assert_tool gh "https://cli.github.com/  或  apt/brew 装 GitHub CLI"
assert_tool git "https://git-scm.com/"
ok "gh  → $(command -v gh)"
ok "git → $(command -v git)"

# ---------- 2. gh 登录态 ----------
step "检查 gh 登录态…"
if ! gh auth status >/dev/null 2>&1; then
  warn "尚未登录 gh。"
  if [[ -z "$FORCE" ]]; then
    read -r -p "现在就登录吗？[Y/n] " ans
    if [[ -z "$ans" || "$ans" =~ ^[Yy]$ ]]; then
      gh auth login
    else
      err "已取消：gh 未登录"
      exit 3
    fi
  else
    err "gh 未登录且 FORCE=1，退出。"
    exit 3
  fi
fi
whoami="$(gh api user --jq '.login' 2>/dev/null || echo "")"
if [[ -n "$whoami" ]]; then ok "已登录：$whoami"; fi

# ---------- 3. 推导仓库名 / 描述 ----------
project_root="$(pwd)"
if [[ -z "$REPO_NAME" ]]; then
  REPO_NAME="$(basename "$project_root")"
fi
if [[ -z "$DESCRIPTION" ]] && [[ -f package.json ]]; then
  if command -v node >/dev/null 2>&1; then
    DESCRIPTION="$(node -e "try{const p=require('./package.json');process.stdout.write(p.description||'')}catch(e){}" 2>/dev/null || echo "")"
  fi
  if [[ -z "$DESCRIPTION" ]]; then
    DESCRIPTION="$(grep -m1 '"description"' package.json | sed 's/.*"description"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo "")"
  fi
fi
DESCRIPTION="${DESCRIPTION:-$REPO_NAME}"

info "仓库名：$REPO_NAME"
info "可见性：$VISIBILITY"
info "描述  ：$DESCRIPTION"
info "分支  ：$BRANCH"
info "远程  ：$REMOTE"

run() {
  if [[ -n "$DRY_RUN" ]]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

# ---------- 4. git 初始化 ----------
step "准备本地 git…"
if [[ ! -d .git ]]; then
  info "未发现 .git，初始化…"
  run "git init -b $BRANCH"
  ok "git init 完成"
else
  ok "已是 git 仓库"
fi

# 配置 user（如果缺失）
if ! git config user.name  >/dev/null 2>&1; then
  warn "未配置 git user.name，使用占位值。"
  run "git config user.name  '${whoami:-github-user}'"
fi
if ! git config user.email >/dev/null 2>&1; then
  warn "未配置 git user.email，使用占位值。"
  run "git config user.email '${whoami:-github-user}@users.noreply.github.com'"
fi

current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ -z "$current_branch" ]]; then
  run "git checkout -b $BRANCH"
  current_branch="$BRANCH"
fi
info "当前分支：$current_branch"

# ---------- 5. 远程仓库 ----------
repo_exists_on_github=0
remote_url="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
if [[ -n "$remote_url" ]]; then
  ok "已配置远程：$REMOTE → $remote_url"
  if gh repo view "$REPO_NAME" --json name >/dev/null 2>&1; then
    repo_exists_on_github=1
  fi
else
  if gh repo view "$REPO_NAME" --json name >/dev/null 2>&1; then
    repo_exists_on_github=1
    warn "GitHub 上已存在同名仓 $REPO_NAME，将添加为远程。"
    owner="$(gh repo view "$REPO_NAME" --json owner --jq '.owner.login' 2>/dev/null || echo "$whoami")"
    https_url="https://github.com/$owner/$REPO_NAME.git"
    ssh_url="git@github.com:$owner/$REPO_NAME.git"
    chosen="$https_url"
    if [[ -z "$FORCE" ]]; then
      read -r -p "选择远程协议 [1] https  [2] ssh  (默认 1) " ans
      if [[ "$ans" == "2" ]]; then chosen="$ssh_url"; fi
    fi
    run "git remote add $REMOTE $chosen"
    ok "已添加远程：$chosen"
  else
    if [[ -n "$NO_CREATE" ]]; then
      err "远程仓不存在，且指定了 NO_CREATE=1。退出。"
      exit 4
    fi
    step "在 GitHub 上创建仓库 $REPO_NAME ($VISIBILITY)…"
    if [[ -z "$FORCE" ]]; then
      read -r -p "确认创建？[Y/n] " ans
      [[ -z "$ans" || "$ans" =~ ^[Yy]$ ]] || { err "已取消"; exit 5; }
    fi
    run "gh repo create $REPO_NAME --$VISIBILITY --description \"$DESCRIPTION\" --source . --remote $REMOTE --push"
    ok "仓库已创建并推送"
  fi
fi

# ---------- 6. 暂存 / 提交 ----------
step "添加并提交变更…"
run "git add -A"

if [[ -z "$(git status --porcelain)" ]]; then
  ok "工作区干净，无需提交"
else
  info "待提交变更数：$(git status --porcelain | wc -l | tr -d ' ')"
  run "git commit -m \"$MESSAGE\""
  ok "已提交：$MESSAGE"
fi

# ---------- 7. 推送 ----------
if [[ $repo_exists_on_github -eq 1 || -z "$(git remote 2>/dev/null)" ]]; then
  step "推送到 GitHub…"
  if ! run "git push -u $REMOTE $current_branch"; then
    warn "推送失败，尝试 pull --rebase 后再推…"
    run "git pull --rebase --autostash $REMOTE $current_branch" || true
    run "git push -u $REMOTE $current_branch"
  fi
  ok "推送完成"
fi

# ---------- 8. 收尾 ----------
repo_url="$(gh repo view "$REPO_NAME" --json url --jq '.url' 2>/dev/null || echo "")"
echo ""
ok "完成。"
if [[ -n "$repo_url" ]]; then
  echo "  仓库地址：$repo_url"
fi
echo ""
