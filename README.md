# GrokSwitch

一个美观的 Windows 桌面小工具，用于快速切换 [Grok Build](https://github.com/xai-org/grok) 的第三方模型配置。

## 功能

- 一键切换默认模型
- 内置常见服务商预设：DeepSeek、OpenAI、Anthropic、Ollama、SiliconFlow、OpenRouter
- 添加 / 编辑 / 删除自定义模型
- 自动读写 `~/.grok/config.toml`
- 暗色主题、卡片式界面

## 使用

直接运行：

```text
E:\interesting\grokswitch\dist\win-unpacked\GrokSwitch.exe
```

首次启动会自动读取你已有的 `~/.grok/config.toml`。

## 开发

```bash
cd E:\interesting\grokswitch
npm install
npm start          # 开发模式运行
npm run dist       # 打包 Windows 可执行文件
```

## 配置说明

GrokSwitch 修改的是 Grok 的 `~/.grok/config.toml` 文件，具体字段含义可参考 [Grok 官方自定义模型文档](https://github.com/xai-org/grok/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md)。

示例配置：

```toml
[models]
default = "deepseek-v3"

[model.deepseek-v3]
model = "deepseek-chat"
base_url = "https://api.deepseek.com/v1"
name = "DeepSeek V3"
api_key = "sk-..."
api_backend = "chat_completions"
context_window = 64000
```

## 注意事项

- 当前打包为**便携版**（`win-unpacked/GrokSwitch.exe`），无需安装。
- 打包 NSIS 安装包需要 Windows 管理员权限或开启“开发者模式”（用于创建符号链接）。如果只需要便携版，直接运行上面的 exe 即可。
