# prompts — 给 AI 的全部指令 / every instruction the AI is given

这个文件夹放的就是 NonZeroScript 发给 AI、以及要求 AI 遵守的说明。运行时不会读取
这里的文件：插件里的实际文本在 `extension/core/config.js`，命令目录由
`controller/tools.json` 提供；这里是可读、可对比、可翻译的完整副本。

| 文件 | 内容 |
|---|---|
| [`system-prompt.md`](system-prompt.md) | 完整的系统提示词模板，运行时填入 `{{PLACEHOLDER}}` 部分。 |
| [`agent-rules.md`](agent-rules.md) | 上面规则的清单版：每条回复只发一条命令、代码块写法、先检查再修改、什么时候算完成。 |
| [`tool-catalogue.md`](tool-catalogue.md) | 全部命令、参数和说明（29 个，按分组排列）。 |
| [`repair-messages.md`](repair-messages.md) | 回复无法解析时回给 AI 的提示，让它自己改正。 |

想调整 AI 的行为时：改 `extension/core/config.js` 里的提示词文本；想改命令本身，
改 `controller/tools.json`，然后同步本文件夹里对应的文档。`操控台 → 追加给 AI 的
自定义指令` 可以在不改文件的情况下追加风格要求。
