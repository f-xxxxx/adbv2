# ADB 节点工作流（ComfyUI 风格）

这个项目实现了一个“节点编排工作流”来完成以下流程：

1. 开始节点选择 Android 设备  
2. 点击节点（Tap）  
3. 滑动节点（Swipe，上滑/下滑）  
4. 截图节点（Screenshot，支持滚动截图）  
5. 回传截图到电脑（PullToPC，可设置保存目录）  
6. EasyOCR 节点（支持多个区域识别）  
7. 导出 Excel（ExportExcel）
8. 展示结果（PreviewExcel，表格展示前 N 条）
9. 图片预览（PreviewImages，按文件夹预览图片）

## 新特性（近期）

- 执行层解耦：API 层与执行层分离，手动执行/调度执行统一走执行队列接口。
- 节点插件化：支持内置节点 + `plugins/nodes` 目录插件 + `entry_points`（组名 `adbflow.nodes`）。
- 状态持久化升级：调度、运行记录、报告索引、节点事件统一存储到 SQLite。
- 可观测性增强：结构化日志（`run_id/schedule_id/node_id`）、统一错误码、`/health`、`/metrics`。
- 运行回放：每次执行记录节点级 timeline，可在 WebUI “运行回放”页签查看耗时与失败节点并播放回放。

## 1. 环境准备

- 安装 Python 3.10+
- 安装 Android Platform Tools（包含 `adb`），并保证命令行可用：
  - `adb version`
- 手机开启开发者模式与 USB 调试，执行：
  - `adb devices`

安装依赖：

```bash
pip install -r requirements.txt
```

## 2. 启动可视化节点编排页面

```bash
python webapp.py
```

然后在浏览器打开：

- `http://127.0.0.1:7860`

页面支持：

- 拖拽添加节点
- 连线形成链路
- 一键执行工作流
- 实时日志查看
- 导出当前工作流 JSON 到本地文件
- 启动后默认加载 `workflows/example_workflow.json`
- 右上角“加载工作流”可从 `workflows` 目录选择任意 JSON 工作流
- 右上角“加载工作流”也支持选择本地 JSON 文件导入
- 底部面板支持“执行报告”Tab，可视化展示最近执行报告
- 底部面板支持“运行回放”Tab，展示节点级时间线（耗时、失败点、播放回放）

执行报告策略：
- 手动执行（非调度）报告固定写入 `outputs/reports/manual_latest.json`（每次覆盖）
- 调度执行报告按任务 ID 固定命名（每个调度任务覆盖同名报告）

SQLite 持久化文件：
- `schedules/adbflow.db`
- 主要表：
  - `schedules`: 调度任务快照
  - `runs`: 执行记录
  - `reports`: 报告索引
  - `node_events`: 节点级事件（用于运行回放与节点耗时统计）

### 一键启动脚本

- macOS（zsh）：

```bash
chmod +x start.command
./start.command
```

- Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\start_windows.ps1
```

- Windows（双击启动）：

```bat
start_windows.bat
```

## 3. CLI 执行（可选）

也可以直接运行 JSON 工作流：

```bash
python -m src.adbflow.runner --workflow workflows/example_workflow.json
```

仅打印某个节点输出：

```bash
python -m src.adbflow.runner --workflow workflows/example_workflow.json --print-output-node 7
```

## 4. 节点参数说明

### StartDevice
- `device_id`: 指定设备序列号；留空时自动选择（单设备模式）

### Tap
- `x`, `y`: 点击坐标

### Swipe
- `direction`: `up` 或 `down`
- `duration_ms`: 滑动时长（毫秒）
- `distance_px`: 按方向模式滑动的像素距离（支持设置起点 `x`,`y`）
- 也可直接设置 `x1,y1,x2,y2` 覆盖方向策略

### Wait
- `duration_sec`: 等待秒数（支持小数）

### Screenshot
- `remote_dir`: 手机侧保存目录（例如 `/sdcard/adbflow`）
- `prefix`: 文件名前缀
- `scroll`: 是否滚动截图
- `scroll_count`: 滚动截图帧数
- `scroll_distance_px`: 每次滚动滑动像素（仅 `scroll=true` 时生效）
- `scroll_direction`: `up` 或 `down`
- `swipe_duration_ms`, `swipe_pause_sec`, `capture_pause_sec`: 节奏参数

### LoopStart
- `loop_count`: 循环次数
- `loop_start_wait_sec`: 每轮开始前等待秒数（第 2 轮起生效，建议 0.5~1.0）
- 作为容器起点，放在要循环的节点前面

### LoopEnd
- 作为容器终点，放在要循环的节点后面
- 引擎会自动找到最近上游 `LoopStart`，并循环执行两者之间的节点
- 每轮输出会作为下一轮输入继续传递，可用于累计截图结果

### PullToPC
- `save_dir`: 电脑本地保存目录
- `clear_save_dir`: 是否在回传前清空 `save_dir`（默认 `false`，开启有删除历史文件风险）
- `stitch_scroll`: 多张图是否自动拼接成长图
- `max_overlap_px`: 拼接重叠搜索范围
- `cleanup_remote`: 是否清理手机上的临时截图
- 当 `clear_save_dir=true` 时，会先清空 `save_dir` 目录中的旧截图，再写入新截图

### EasyOCR
- `languages`: 例如 `ch_sim,en`
- `gpu`: 是否启用 GPU
- `use_all_images`: 是否对全部截图做 OCR（否则优先识别拼接图）
- `image_dir`: 图片文件夹路径。设置后可直接从该节点启动工作流（无需上游截图节点）
- `regions`: 支持多个区域，JSON 数组，例如：

```json
[
  {"name":"title","x":60,"y":100,"w":900,"h":220},
  {"name":"content","x":40,"y":360,"w":980,"h":1500}
]
```

在 WebUI 中可通过“文字识别节点 -> 编辑识别区域(多行) -> 选区辅助工具”上传截图后框选区域，自动生成 `x/y/w/h`。

### ExportExcel
- `output_path`: Excel 输出路径，如 `outputs/ocr_result.xlsx`
- 导出列格式：
  - `序号`
  - `图片`
  - `EasyOCR` 节点中 `regions` 的 `name`（每个区域一个列）

### PreviewExcel
- `max_rows`: 预览条数，默认 `10`
- 从上游读取 `excel_path`，在 WebUI 底部预览表格中展示

### PreviewImages
- `folder_dir`: 图片文件夹路径（可选）
- `max_images`: 最大预览张数，默认 `12`
- 可连接 `PullToPC` 节点（自动使用 `save_dir`）或 `EasyOCR` 节点（自动使用 OCR 输入图片目录）
- 执行后图片会直接显示在“图片预览节点”内部（类似 ComfyUI 图片预览节点）

## 4.1 插件化节点

插件目录：
- `plugins/nodes`

示例：
- `plugins/nodes/sample_plugin.py`

插件注册方式（二选一）：

1) 目录插件（推荐）
- 在 `plugins/nodes` 放置 `*.py`
- 插件模块可提供：
  - `register(register_node)` 函数，内部调用 `register_node("ClassType", Factory, overwrite=True/False)`
  - 或 `NODE_FACTORIES = {"ClassType": Factory, ...}`

2) Python 包 `entry_points`
- 组名：`adbflow.nodes`
- 载荷支持：
  - 可调用对象（接收 `register_node`）
  - 或返回节点工厂字典

说明：
- 引擎初始化时会自动加载内置节点与插件节点。
- 插件加载失败不会阻断系统启动，会记录结构化日志事件。

## 5. 工作流格式（ComfyUI 风格）

节点通过 `["node_id", output_index]` 引用上游输出，示例见：

- `workflows/example_workflow.json`
- `workflows/example_folder_ocr_workflow.json`（从图片文件夹直接 OCR 的示例）
- `workflows/example_screenshot_only_workflow.json`（仅截图并回传到电脑）
- `workflows/example_loop_sequence_workflow.json`（使用循环开始/循环结束容器循环执行“点击->截图->返回->上滑”）

## 6. 注意事项

- 若有多个设备，请在 `StartDevice.device_id` 指定序列号，避免误操作。
- 滚动截图拼接在不同 App 页面上可能需要调 `max_overlap_px` 和截图节奏参数。
- EasyOCR 首次加载模型会较慢，属于正常现象。

## 7. 关键接口（新增）

- `GET /health`
  - 服务与 DB 健康状态
- `GET /metrics?top_n=5`
  - 运行次数、失败率、平均耗时、节点耗时 TopN
- `GET /api/run/timeline?run_id=<run_id>`
- `GET /api/run/timeline?report_path=<abs_report_path>`
  - 返回节点级 timeline（`node_id/class_type/status/start_ts/end_ts/duration_ms/error`）
- `GET /api/runtime-status`
  - 包含执行队列状态（`queue_size/running_task_id/submitted/finished`）
