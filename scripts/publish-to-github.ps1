$ErrorActionPreference = 'Stop'
$owner = 'ngogiaidy56-eng'
$repo = 'hendy-ai-cover'
$fullName = "$owner/$repo"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'Chua cai GitHub CLI (gh). Cai tai https://cli.github.com/ roi chay lai.'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Chua cai Git. Cai Git for Windows roi chay lai.'
}

gh auth status
if ($LASTEXITCODE -ne 0) { throw 'Can dang nhap GitHub bang lenh: gh auth login' }

if (-not (Test-Path '.git')) {
    git init -b main
    if ($LASTEXITCODE -ne 0) { throw 'git init that bai.' }
}

git add -A
if ($LASTEXITCODE -ne 0) { throw 'git add that bai.' }

$hasCommit = $true
git rev-parse --verify HEAD *> $null
if ($LASTEXITCODE -ne 0) { $hasCommit = $false }
if (-not $hasCommit) {
    git commit -m 'Initial Hendy AI Cover Basic release'
    if ($LASTEXITCODE -ne 0) { throw 'git commit that bai. Hay cau hinh git user.name va git user.email.' }
} else {
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        git commit -m 'Update Hendy AI Cover Basic'
        if ($LASTEXITCODE -ne 0) { throw 'git commit that bai.' }
    }
}

$origin = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $origin) {
    if ($origin -notmatch 'github\.com[:/]ngogiaidy56-eng/hendy-ai-cover(?:\.git)?$') {
        throw "Remote origin dang tro toi repo khac: $origin. Hay doi origin truoc khi tiep tuc."
    }
} else {
    gh repo create $fullName --private --source . --remote origin --push --description 'Hendy AI Cover Basic - Telegram AI cover with licensed preset voice conversion'
    if ($LASTEXITCODE -ne 0) { throw 'Khong tao/push duoc repo. Kiem tra quyen tao repository tren GitHub.' }
    Write-Host "Repository created: https://github.com/$fullName"
    exit 0
}

git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'git push that bai.' }
Write-Host "Changes pushed to: https://github.com/$fullName"
