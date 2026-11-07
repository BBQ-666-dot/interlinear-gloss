# Interlinear Gloss

[![Release](https://img.shields.io/github/v/release/BBQ-666-dot/interlinear-gloss)](https://github.com/BBQ-666-dot/interlinear-gloss/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

在 Obsidian 里读英文教材时，选中一句话或一段话，一次性生成**中文译文 + 关键词释义**，永久保存在原文下方。不联网、不重复请求模型；关掉 Ollama 也能继续读已经生成过的内容。

- Markdown 笔记：生成 ```` ```gloss ```` 代码块，插在原文段落下面（便携模式则插原生表格）
- PDF：右侧栏生成词义卡片，缓存到 sidecar JSON；在正文里选一个词，还能就地加**词级标注**（高亮 + 词下中文标签）

## 使用

先把本地模型跑起来：

```powershell
ollama serve                 # 通常已在后台
ollama pull hy-mt2-1.8b-q8:latest
ollama pull qwen2.5:3b
```

然后在 Obsidian 里（命令面板 `Ctrl+P`）：

| 命令 | 作用 |
| --- | --- |
| `Interlinear Gloss: 为选中内容生成词义` | 选中文本 → 在段落下插入词义块 |
| `Interlinear Gloss: 为当前段落生成词义` | 光标所在段落 |
| `Interlinear Gloss: 重新生成词义` | 光标在已有词义块里时重做 |
| `Interlinear Gloss: 删除词义` | 删掉光标附近的词义块 |
| `Interlinear Gloss: 打开 PDF 词义侧栏` | 右侧栏；可点「译选中」 |
| `Interlinear Gloss: 标注 PDF 选中词` | 选一个词 → 高亮；默认快捷键 `Ctrl+Shift+A`（macOS `Cmd+Shift+A`） |
| `Interlinear Gloss: 编辑 PDF 标注` | 光标所在的标注（或在侧栏点标签） |
| `Interlinear Gloss: 删除 PDF 标注` | 删掉选中的标注 |
| `Interlinear Gloss: 显示/隐藏 PDF 标注` | 临时关掉高亮与标签 |
| `Interlinear Gloss: 诊断` | 打印服务商/模型/PDF/缓存/标注状态 |

默认快捷键只作用于「标注 PDF 选中词」：`Ctrl+Shift+A`（macOS `Cmd+Shift+A`）。如果和你的其他快捷键冲突，到「设置 → 快捷键」搜索 `Interlinear Gloss` 改成自己的组合。

同一段文字下面已经有词义块时不会重复插入，而是弹窗问「重新生成 / 删除 / 取消」。生成过的内容直接存在笔记里，**再次打开笔记不需要任何请求**。

## 生成的块长什么样

```gloss
{
  "version": 1,
  "sourceText": "The beginning of this book is a simplified version of ...",
  "translation": "这本书的开头是……",
  "items": [
    { "source": "journey", "pos": "n.", "target": "旅程" }
  ],
  "mode": "keywords",
  "model": "hy-mt2-1.8b-q8:latest",
  "createdAt": "2026-11-07T09:59:00.000Z",
  "meta": { "glossaryModel": "qwen2.5:3b", "chunks": 1, "promptVersion": 3 }
}
```

阅读视图里渲染成 callout 卡片：原文（可关）→ 译文 → 表格（单词/短语 | 词性 | 释义）→ 重新生成 / 复制 / 删除。

## 三个输出模式

| 模式 | 形式 | 适用 |
| --- | --- | --- |
| 关键词表（默认） | `gloss` 代码块 → 渲染成卡片 | 日常阅读 |
| 严格逐词 | 每个英文词下面带中文的 CSS 双行对照 | 精读，实验性 |
| 便携 Markdown | 原生表格，无代码块 | 想在其他 Markdown 工具里看、或要复制给别人 |

便携模式用 `<!-- ig-gloss:<hash> -->` / `<!-- /ig-gloss -->` 两个不可见注释包住表格，所以预览里不显示、插件仍能定位和重新生成。

## PDF 词级标注（0.3.0）

在 PDF 里选中一个英文单词或短语（≤40 字符），执行「标注 PDF 选中词」（或侧栏的「标注选中词」）：

- 选区会**自动吸附到完整单词**：pdf.js 把一个词拆成多个 span 时，双击常常从第二个字母开始（`ontains`），现在会先把 Range 向两侧扩到词边界，所以保存的是 `contains`，高亮也覆盖整个词；双击常把词后的空格一起带进来，吸附时会先剥掉首尾空白与标点，不会再把下一个词吞成 `contain tan`；
- 原词上出现一层高亮（默认黄色，`mix-blend-mode: multiply`，不会盖住字形）；高亮层不拦截鼠标，PDF 里照常框选文字；
- **默认 none**：正文上不显示任何文字，释义看右侧栏；想要词下浮卡可切到 `hover`（白底、9px 起、不常驻、不换行，移开消失），卡片直接读 sidecar，不会因此再请求一次模型；
- 浮标字号跟随正文（`pageFont × 0.72`，最小 9px、上限 15px），缩放 PDF 时重测，100%/125%/150%/200% 都贴得住；
- 卡片宽度按实测文字宽度 + 左右内边距算，短词不会被省略号裁掉；
- 层级在 pdf.js 文字层之上，不会被正文盖住；点卡片打开编辑弹窗，改完立即重绘；
- 措辞按词性区分：形容词给「…的」形式（`correlated → 相关的`），名词给原形（`journey → 旅程`、`chapters → 章节`）；
- 侧栏「词标注」列表按页列出全部标注，可定位、编辑、删除；
- 标注写在 `<vault>/Glosses/pdf/<书名>-<短hash>.marks.json`，和段落词义的 `.gloss.json` 分开，**不改 PDF 文件本身**；
- 同一个位置重复选中不会重新请求模型，直接定位到已有标注。
- 想改成常驻标签（塞行间 / 压字 / 贴页边 / 只高亮），在设置 →「释义显示方式」里切。
- 单词释义优先查**内置离线词典**（ECDICT 精简词库，约 3.7 万词，MIT）；查不到且允许兜底时才走同一条 Ollama 连接。

### 离线词典

- 内置 `data/dictionary.tsv` + `data/lemma.tsv`，构建时打进 `main.js`，不联网、不占显存。
- `obtain → 获得；达到`、`contents → 内容；…`、`chapters → 章；回；章节…`；术语表（policy/return/reward 等）优先于词典。
- 词形变化走 lemma 表 + 后缀规则，`obtained / obtaining / chapters` 都能还原。
- 词典未收录时：默认允许模型兜底；可在设置里关掉，只提示“未收录”。
- 数据来源：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

标签定位的几种情况：

默认 none 不占任何版面；下面是切到 hover / 常驻模式时的行为：

| 情况 | 行为 |
| --- | --- |
| 只高亮不显示文字（`none`） | 释义只在右侧栏 |
| 悬停（`hover`） | 词下浮出小卡片，移开消失，正文不被占用 |
| 行间空隙 ≥ 标签高度（约 11–13px） | `gap`：标签塞进空隙，垂直居中 |
| 空隙比标签还窄（教材常见 5.4px） | `overlap`：白色小卡片贴住词底，压住下一行顶部 1px 左右 |
| 正文最后一行 / 页面底部 | 放到原词上方 |
| 同一行多个标签互相压 | 只显示最近创建或鼠标悬停的那条，其余保留高亮 |
| 重新渲染后坐标失效 | 用前后文在文字层里重新锚定；仍找不到就只留在侧栏并提示「无法定位」 |

## 为什么是两个模型

原始需求假设「一个 1.8B 模型，一个 prompt 同时出译文和词义」。实测在本机不成立，因此拆成了两次调用、可分别指定模型（设置里叫「翻译模型」和「词义模型」）：

| 模型 | 完整 prompt（译文+词义） | 只问词义 |
| --- | --- | --- |
| `hy-mt2-1.8b-q8` | 6.0s，**只有译文，`【词义】`整段缺失** | 把英文原样吐回（6.3s），不可用 |
| `hy-mt2-7b-q5` | 26.9s，译文好，11 行词义但格式脏（词性和释义挤一格、空 source 行），解析出 7 条 | 12.5s 只输出 1 行，不可用 |
| `qwen2.5:3b` | 10.1s，译文一般，词义列错位 | 7.9s，13 行干净词义，可用 |

结论：`hy-mt2-1.8b-q8` 是**翻译专用**模型，指令遵循只够做一件事；`qwen2.5:3b` 是唯一能稳定输出三列词义表的。所以默认 `hy-mt2-1.8b-q8` 译 + `qwen2.5:3b` 词义，一个验收段落约 4–5 秒（1.1–1.5s 翻译 + 3s 词义，20 个词条）。

## 关键词是怎么挑的

只靠模型自由发挥时，`qwen2.5:3b` 会挑 `exploration / policy / reward` 这类术语，但**永远不挑 `journey / map / chapters` 这类比喻性骨架词**——而那往往才是读不懂的地方。所以引擎先用机械规则从原文抽一批候选词（去停用词、去 `serves / later / developed` 这类填充词、去单字母、术语表里的词降权），再按**全文均匀取样**（不是只取开头）交给模型逐条写释义，最后用 `recoverCandidateItems` 按候选词把模型排歪的行捞回来。

三道保险保证候选词不会静默消失：

1. **均匀取样**：候选词数量跟随「词条上限」（默认 20），首/中/尾都覆盖，`correlated` 这种出现在段落后半段的词也会入选；
2. **定向补译**：生成后对比候选词与本轮拿到的词条，缺的词会再发一次只说这几个词的窄请求补上；
3. **显式告警**：补译后仍缺的词会写进块里的警告（`有 N 个候选词没取到释义：…`），不再假装成功。

模型偶尔（约 1/5 次）面对长候选列表会改答散文，此时自动用 8 个候选词的短列表重试一次。

术语表（policy → 策略 等 18 条 RL 术语）参与 prompt 和一致性检查：译文里出现 `政策/方针` 这类错译会在块里给出警告。

## 公式与代码

`$...$`、`$$...$$`、`\(...\)`、`\[...\]`、反引号代码、URL、`[[wikilink]]`、引用在发给模型前替换成 `⟦MATH1⟧` 占位符，回来后原样还原，因此 `$v_\pi(s)$` 不会变成奇怪的中文。占位符在模型输出里被改写或丢失时，会退回原文并在块里给出警告。

## 设置

- 服务商：Ollama（默认 `http://127.0.0.1:11434`）或任意 OpenAI 兼容端点
- 翻译模型 / 词义模型 / 兜底模型 / 温度 / maxTokens / 上下文长度 / 超时
- 输出模式、目标语言、词条上限（默认 20）、单次输入字符上限、块内是否显示原文、「整理词义」开关（关掉只出译文）
- 自定义术语表（`policy = 策略` 一行一条，支持 `=` `:` `|` `→` `——`）
- PDF：词义记录默认写进 vault（`Glosses/pdf/<书名>.gloss.json`，随 vault 同步）；也可关掉改为只放 localStorage
- PDF 词级标注：启用开关、优先离线词典、词典未收录时模型兜底、词标注模型（仅兜底）、标签位置（none/hover/gap/overlap/margin，默认 none）、字号缩放、高亮颜色与不透明度、是否显示词性、选中字符上限、标注文件位置
- 诊断：测试连接、查看模型列表、打印当前 PDF 页与缓存路径

API Key 走 `app.secretStorage`（系统钥匙串），不写进 `data.json`。

## 构建

```powershell
npm install
npm run build      # → main.js
npm test           # 147 项自测 + 真实 Ollama 集成测试（IG_OFFLINE=1 跳过模型用例 = 136 项）
npm run typecheck
```

安装：

1. 从 [Releases](https://github.com/BBQ-666-dot/interlinear-gloss/releases) 下载最新的 `manifest.json`、`main.js`、`styles.css`。
2. 放进 `<vault>/.obsidian/plugins/interlinear-gloss/`。
3. 在「设置 → 第三方插件」里启用 Interlinear Gloss。
4. 也可以把仓库地址加进 BRAT 安装。

## 已知限制

- 严格逐词模式是逐词对齐的近似（`Intl.Segmenter` 分词 + 去复数），不做真正的词形还原
- PDF 页码依赖 Obsidian 内部的 pdf.js 视图：拿不到时显示 `P?`，记录照常保存，不阻塞使用
- 段落词义表质量取决于 `qwen2.5:3b`：可能把已有的术语再写一遍；漏掉的候选词会被补译，补不上时块里会有警告。PDF 词标注优先走离线词典，不再依赖它猜单词。
- PDF 词义记录默认存进 vault（`Glosses/pdf/`），换设备、清缓存都不会丢；如果不想让 vault 里多出文件，在设置里关掉「把缓存写进 vault」即可
- maxTokens 默认 1024；个别极端长句的译文仍有可能被截断，看到译文戛然而止就把这个值再调大
- 一个长段落会按 1400 字符切块，每块单独请求，所以很长的段落耗时是线性的
- 词级标注依赖 Obsidian 内置 pdf.js 的 DOM（`.page[data-page-number]`、`.textLayer`）——这是内部实现，Obsidian 升级可能改变结构；找不到页面元素时标注不会画出来，但侧栏记录与 sidecar 文件都不会丢
- 标注只做「同一页内的单词或短语」；跨页选择会直接提示，不会硬塞

## 开源协议

MIT License，见 [LICENSE](LICENSE)。

## 项目地址

https://github.com/BBQ-666-dot/interlinear-gloss

欢迎 issue、PR，或者直接提你遇到的具体页面/词。

