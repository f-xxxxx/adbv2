# 安卓自动化工作台（ADBFlow）

基于 LiteGraph 的可视化 Android 自动化编排工具。  
支持“拖拽节点 -> 连线 -> 执行 -> 报告/回放/结果预览”完整链路。

## 功能概览

- 节点编排执行：开始、点击、滑动、等待、截图、回传、OCR、导出表格、结果展示、图片预览
- 手动执行与调度执行统一走执行队列（超时、重试、熔断、去重）
- 执行报告 + 节点级运行回放（timeline）
- SQLite 持久化（调度任务、运行记录、报告索引、节点事件）
- 结构化日志（项目根目录 `logs/YYYY-MM-DD.txt`）
- 临时文件守护清理（`outputs/tmp`）
- 节点插件扩展（`plugins/nodes` + `entry_points`）
- 前端离线可用（`litegraph.js` 使用本地资源）

## 环境准备

- Python 3.10+
- Android Platform Tools（`adb` 可用）
- 手机开启开发者模式 + USB 调试

验证：

```bash
adb version
adb devices
```

安装依赖：

```bash
pip install -r requirements.txt
```

## 启动方式

### 直接启动

```bash
python webapp.py
```

浏览器访问：`http://127.0.0.1:7860`

### 一键脚本

- macOS

```bash
chmod +x start.command
./start.command
```

- Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .\start_windows.ps1
```

- Windows 双击

```bat
start_windows.bat
```

## WebUI 说明

- 启动后默认加载 `workflows/example_workflow.json`
- 支持从 `workflows/*.json` 加载或本地 JSON 导入
- 底部面板支持 4 个 Tab：
  - 执行日志
  - 执行报告
  - 执行回放
  - 结果预览
- 图片预览节点支持节点内轮播预览，双击可打开居中大图弹窗

## 节点说明（当前版本）

### StartDevice（开始节点）

- `device_id`：设备序列号；留空时自动选择（仅单设备）

### InputFill（输入节点）

- `text_channel`：`clipboard` / `auto` / `adb_keyboard` / `input_text`
- `text`：输入文本

### Tap（点击节点）

- `x`, `y`：点击坐标
- 支持“图片取点”，可直接抓取手机当前屏幕辅助取点

### Swipe（滑动节点）

- `direction`：`up` 或 `down`
- `duration_ms`：滑动时长
- `distance_px`：方向模式下的滑动像素
- `x`, `y`：方向模式起点（可选）
- `x1,y1,x2,y2`：显式坐标模式（提供后优先）
- 支持“图片取点(起止)”并可抓取手机当前屏幕

### Wait（等待节点）

- `duration_sec`：等待秒数（支持小数）

### Screenshot（截图节点）

- `remote_dir`：手机保存目录（默认 `/sdcard/adbflow`）
- `prefix`：文件名前缀

说明：当前版本已移除“滚动截图”相关参数和逻辑。

### LoopStart / LoopEnd（循环容器）

- `LoopStart.loop_count`：循环次数
- `LoopStart.loop_start_wait_sec`：每轮开始前等待秒数
- 引擎会自动定位 LoopStart~LoopEnd 区间并重复执行

### PullToPC（回传节点）

- `save_dir`：电脑保存目录
- `clear_save_dir`：执行前清空目录（高风险）
- `cleanup_remote`：回传后清理手机临时图

说明：当前版本已移除“拼接长图 / 最大重叠像素”相关功能。

### EasyOCR（文字识别节点）

- `languages`：如 `ch_sim,en`
- `gpu`：是否启用 GPU
- `image_dir`：图片目录（设置后可脱离上游截图直接 OCR）
- `regions`：JSON 数组/对象，支持多区域

区域编辑支持：

- 多行 JSON 编辑器（可格式化）
- 选区辅助工具（上传图片框选生成坐标）

### ExportExcel（导出表格节点）

- `output_path`：导出路径（如 `outputs/docs/ocr_result.xlsx`）
- `append_mode`：增量导出
- `dedup_keys`：去重键（来自上游 OCR 区域名）
- `invalid_data_key`：无效数据主键（来自上游 OCR 区域名）

行为：

- 若设置 `invalid_data_key`，该键识别为空的记录不写入
- 支持预览前 N 行（供结果预览 Tab 展示）

### PreviewExcel（展示结果节点）

- `max_rows`：展示条数

### PreviewImages（图片预览节点）

- `folder_dir`：图片目录（无上游连接时可编辑）
- `max_images`：最多展示数量
- `thumb_max_px`：缩略图边长上限

行为：

- 连接上游时，目录由上游自动填充并只读
- 可从 EasyOCR 输入目录或 PullToPC 保存目录自动推断

## 数据与目录

- 数据库：`schedules/adbflow.db`
- 报告目录：`outputs/reports`
- 临时目录：`outputs/tmp`（后台定时清理）
- 日志目录：`logs/YYYY-MM-DD.txt`

SQLite 主要表：

- `schedules`：调度任务快照
- `runs`：执行记录
- `reports`：报告索引
- `node_events`：节点事件（回放与耗时统计）

## API（常用）

- `POST /api/run`：手动执行（非流式）
- `POST /api/run-stream`：手动执行（流式 NDJSON）
- `POST /api/schedules/run-now-stream`：调度立即执行（流式 NDJSON）
- `POST /api/run-cancel`：停止当前执行
- `GET /api/runtime-status`：执行状态与队列状态
- `GET /api/report/read?path=...`：读取执行报告
- `GET /api/run/timeline?run_id=...` 或 `report_path=...`：读取回放
- `GET /api/image/thumb?path=...&max_side=360`：图片缩略图
- `GET /health`：服务健康检查
- `GET /metrics?top_n=5`：运行统计与节点耗时 TopN

## 插件扩展

插件目录：`plugins/nodes`

示例：`plugins/nodes/sample_plugin.py`

支持两种方式：

1. 目录插件（推荐）
- 在 `plugins/nodes` 下放置 `*.py`
- 提供 `register(register_node)` 或 `NODE_FACTORIES`

2. `entry_points`
- 组名：`adbflow.nodes`

## CLI（可选）

```bash
python -m src.adbflow.runner --workflow workflows/example_workflow.json
```

打印指定输出节点：

```bash
python -m src.adbflow.runner --workflow workflows/example_workflow.json --print-output-node 7
```

## 示例工作流

- `workflows/example_workflow.json`
- `workflows/example_folder_ocr_workflow.json`
- `workflows/example_screenshot_only_workflow.json`
- `workflows/example_loop_sequence_workflow.json`
- `workflows/example_loop_tap_input_tap_workflow.json`

## 注意事项

- 多设备场景请显式设置 `StartDevice.device_id`
- OCR 首次加载模型会慢一些（正常现象）
- 开启 `clear_save_dir` 会删除目录历史文件，请谨慎使用
