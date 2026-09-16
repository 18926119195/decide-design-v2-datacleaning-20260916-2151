@echo off
set NODE="C:\Program Files\cursor\resources\app\resources\helpers\node.exe"
cd /d "%~dp0"
%NODE% --experimental-strip-types src/server/main.ts
