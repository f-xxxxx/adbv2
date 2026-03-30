#!/usr/bin/env zsh
set -e

# 切换到脚本所在目录（项目根目录）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 首次创建虚拟环境
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

# 激活虚拟环境
source .venv/bin/activate

# 安装依赖（若已安装会很快跳过）
pip3 install -r requirements.txt -i https://pypi.tuna.tsinghua.cn/simple

# 可选：显示设备列表，确认 adb 可用
adb devices

# 启动 Web UI
python3 webapp.py
