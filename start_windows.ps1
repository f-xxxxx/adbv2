$ErrorActionPreference = "Stop"

# Go to script directory (project root)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Pick python launcher
$PythonCmd = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonCmd = "py -3"
}
elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonCmd = "python"
}
else {
    throw "Python was not found. Please install Python 3.10+ and add it to PATH."
}

# Create venv if missing
if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment .venv ..."
    Invoke-Expression "$PythonCmd -m venv .venv"
}

# Activate venv
$ActivateScript = Join-Path $ScriptDir ".venv\Scripts\Activate.ps1"
if (-not (Test-Path $ActivateScript)) {
    throw "Activate script was not found: $ActivateScript"
}
. $ActivateScript

# Install deps
pip install -r requirements.txt

# Optional: list adb devices
adb devices

# Start Web UI
python webapp.py
