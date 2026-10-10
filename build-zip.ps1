# extension 폴더를 배포용 KU-LMS-Plus.zip으로 묶는다.
# 압축을 풀면 KU-LMS-Plus 폴더 하나가 나오도록 만든다.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stage = Join-Path $env:TEMP 'ku-lms-plus-build'
$zip = Join-Path $root 'KU-LMS-Plus.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $root 'extension') (Join-Path $stage 'KU-LMS-Plus') -Recurse

if (Test-Path $zip) { Remove-Item $zip -Force }
# Compress-Archive는 경로 구분자를 \로 저장해 macOS에서 깨지므로 tar를 쓴다
& (Join-Path $env:SystemRoot 'System32\tar.exe') -a -cf $zip -C $stage KU-LMS-Plus
Remove-Item $stage -Recurse -Force
Write-Host "만들었습니다: $zip"
