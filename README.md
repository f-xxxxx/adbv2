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
- 也可直接设置 `x1,y1,x2,y2` 覆盖方向策略

### Screenshot
- `remote_dir`: 手机侧保存目录（例如 `/sdcard/adbflow`）
- `prefix`: 文件名前缀
- `scroll`: 是否滚动截图
- `scroll_count`: 滚动截图帧数
- `scroll_direction`: `up` 或 `down`
- `swipe_duration_ms`, `swipe_pause_sec`, `capture_pause_sec`: 节奏参数

### PullToPC
- `save_dir`: 电脑本地保存目录
- `stitch_scroll`: 多张图是否自动拼接成长图
- `max_overlap_px`: 拼接重叠搜索范围
- `cleanup_remote`: 是否清理手机上的临时截图
- 每次执行会先清空 `save_dir` 目录中的旧截图，再写入新截图

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

## 5. 工作流格式（ComfyUI 风格）

节点通过 `["node_id", output_index]` 引用上游输出，示例见：

- `workflows/example_workflow.json`
- `workflows/example_folder_ocr_workflow.json`（从图片文件夹直接 OCR 的示例）
- `workflows/example_screenshot_only_workflow.json`（仅截图并回传到电脑）

## 6. 注意事项

- 若有多个设备，请在 `StartDevice.device_id` 指定序列号，避免误操作。
- 滚动截图拼接在不同 App 页面上可能需要调 `max_overlap_px` 和截图节奏参数。
- EasyOCR 首次加载模型会较慢，属于正常现象。
