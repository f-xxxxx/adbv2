$ErrorActionPreference = "Stop"

# 切换到脚本所在目录（项目根目录）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# 选择 Python 命令
$PythonCmd = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonCmd = "py -3"
}
elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonCmd = "python"
}
else {
    throw "未找到 Python，请先安装 Python 3.10+ 并加入 PATH。"
}

# 首次创建虚拟环境
if (-not (Test-Path ".venv")) {
    Write-Host "创建虚拟环境 .venv ..."
    Invoke-Expression "$PythonCmd -m venv .venv"
}

# 激活虚拟环境
$ActivateScript = Join-Path $ScriptDir ".venv\Scripts\Activate.ps1"
if (-not (Test-Path $ActivateScript)) {
    throw "未找到虚拟环境激活脚本：$ActivateScript"
}
. $ActivateScript

# 安装依赖（若已安装会很快跳过）
pip install -r requirements.txt

# 可选：显示设备列表，确认 adb 可用
adb devices

# 启动 Web UI
python webapp.py
