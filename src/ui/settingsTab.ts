import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { GlossMode, ProviderId } from '../types';
import { defaultGlossaryText } from '../gloss/glossary';
import type InterlinearGlossPlugin from '../main';

const PROVIDER_LABEL: Record<ProviderId, string> = {
	ollama: 'Ollama（本地）',
	openai: 'OpenAI 兼容接口',
};

const MODE_LABEL: Record<GlossMode, string> = {
	keywords: '关键词表（推荐）',
	strict: '严格逐词（实验）',
	portable: '便携 Markdown（无代码块）',
};

const LANG_LABEL: Record<string, string> = {
	'zh-Hans': '简体中文',
	'zh-Hant': '繁體中文',
	en: 'English',
};

export class GlossSettingTab extends PluginSettingTab {
	private plugin: InterlinearGlossPlugin;
	private modelList: string[] = [];
	private testing = false;

	constructor(app: App, plugin: InterlinearGlossPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('ig-settings');

		containerEl.createEl('h2', { text: 'Interlinear Gloss' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '选中英文段落即可生成中文译文与关键词释义，结果直接写进笔记（PDF 则保存在右侧栏）。默认只连本机 Ollama，不出网。',
		});

		this.renderProviderSection(containerEl);
		this.renderOutputSection(containerEl);
		this.renderGlossarySection(containerEl);
		this.renderPdfSection(containerEl);
		this.renderWordMarkSection(containerEl);
		this.renderDiagnosticsSection(containerEl);
	}

	private async persist(): Promise<void> {
		await this.plugin.saveSettings();
	}

	private renderProviderSection(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		containerEl.createEl('h3', { text: '模型服务' });

		new Setting(containerEl)
			.setName('服务商')
			.setDesc('默认使用本机 Ollama；OpenAI 兼容接口适合自建网关或云服务。')
			.addDropdown((dropdown) => {
				for (const id of Object.keys(PROVIDER_LABEL) as ProviderId[]) {
					dropdown.addOption(id, PROVIDER_LABEL[id]);
				}
				dropdown
					.setValue(settings.provider)
					.onChange(async (value) => {
						settings.provider = value as ProviderId;
						settings.baseUrl =
							value === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com';
						await this.persist();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('服务地址')
			.setDesc(
				settings.provider === 'ollama'
					? 'Ollama 默认 http://127.0.0.1:11434，不要带 /api。'
					: 'OpenAI 兼容地址，例如 https://api.openai.com 或你的网关地址（会自动补 /v1/chat/completions）。',
			)
			.addText((text) =>
				text
					.setPlaceholder('http://127.0.0.1:11434')
					.setValue(settings.baseUrl)
					.onChange(async (value) => {
						settings.baseUrl = value.trim();
						await this.persist();
					}),
			);

		if (settings.provider === 'openai') {
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('保存在系统钥匙串里，不写进 data.json。修改后失去焦点即生效。')
				.addText((text) => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder(this.plugin.hasApiKey() ? '已保存，留空保持不变' : 'sk-...')
						.setValue('')
						.onChange(() => undefined);
					text.inputEl.addEventListener('blur', () => {
						const value = text.inputEl.value.trim();
						if (!value) return;
						this.plugin.setApiKey(value);
						new Notice('API Key 已保存到系统钥匙串');
					});
				});
		}

		new Setting(containerEl)
			.setName('翻译模型')
			.setDesc('只负责把原文译成中文。翻译专用小模型（如 hy-mt2-1.8b）又快又好，推荐留给它。')
			.addText((text) =>
				text
					.setPlaceholder('hy-mt2-1.8b-q8:latest')
					.setValue(settings.model)
					.onChange(async (value) => {
						settings.model = value.trim();
						await this.persist();
					}),
			)
			.addButton((button) =>
				button.setButtonText('查询可用模型').onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('查询中…');
					try {
						this.modelList = await this.plugin.listModels();
						new Notice(
							this.modelList.length
								? `可用模型（${this.modelList.length}）：${this.modelList.slice(0, 12).join(', ')}`
								: '没有查到模型，确认服务地址与服务状态',
							10000,
						);
						this.display();
					} catch (error) {
						new Notice(
							`查询失败：${error instanceof Error ? error.message : String(error)}`,
							8000,
						);
					} finally {
						button.setDisabled(false);
						button.setButtonText('查询可用模型');
					}
				}),
			);

		if (this.modelList.length) {
			new Setting(containerEl).setName('从列表里选模型').addDropdown((dropdown) => {
				dropdown.addOption('', '— 选择 —');
				for (const model of this.modelList) dropdown.addOption(model, model);
				dropdown.setValue(this.modelList.includes(settings.model) ? settings.model : '');
				dropdown.onChange(async (value) => {
					if (!value) return;
					settings.model = value;
					await this.persist();
					this.display();
				});
			});
		}

		new Setting(containerEl)
			.setName('词义模型')
			.setDesc(
				'单独负责列词义表。实测翻译专用模型写不出表格，建议用 qwen2.5:3b 这类通用模型；留空则与翻译模型相同。',
			)
			.addText((text) =>
				text
					.setPlaceholder('qwen2.5:3b')
					.setValue(settings.glossaryModel)
					.onChange(async (value) => {
						settings.glossaryModel = value.trim();
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('兜底模型')
			.setDesc('主模型没给出词义表时用它重跑一次；留空或与主模型相同则关闭。')
			.addText((text) =>
				text
					.setPlaceholder('hy-mt2-7b-q5:latest')
					.setValue(settings.fallbackModel)
					.onChange(async (value) => {
						settings.fallbackModel = value.trim();
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('温度')
			.setDesc('翻译任务建议 0.1–0.3，越高越发散。')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(settings.temperature)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.temperature = value;
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('单次最大输出 token')
			.setDesc('译文 + 词义表都算在里面，512 一般够一个段落。')
			.addText((text) =>
				text.setValue(String(settings.maxTokens)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					settings.maxTokens = Math.min(8192, Math.max(64, parsed));
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('上下文长度 num_ctx')
			.setDesc('提示词 + 原文 + 输出都算在内，8192 适合 1.8B 小模型。')
			.addText((text) =>
				text.setValue(String(settings.numCtx)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					settings.numCtx = Math.min(131072, Math.max(1024, parsed));
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('请求超时（毫秒）')
			.setDesc('本地小模型一般 1–5 秒；7B 兜底建议 60000 以上。')
			.addText((text) =>
				text.setValue(String(settings.requestTimeoutMs)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					settings.requestTimeoutMs = Math.min(300000, Math.max(5000, parsed));
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('质量兜底')
			.setDesc('词义表为空时自动用兜底模型再试一次（慢一倍，但不容易空表）。')
			.addToggle((toggle) =>
				toggle.setValue(settings.qualityFallback).onChange(async (value) => {
					settings.qualityFallback = value;
					await this.persist();
				}),
			);
	}

	private renderOutputSection(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		containerEl.createEl('h3', { text: '输出' });

		new Setting(containerEl)
			.setName('输出模式')
			.setDesc(
				'关键词表最稳；严格逐词会把原文切成两行对齐的小块（实验）；便携模式写纯 Markdown，撤掉插件也能读。',
			)
			.addDropdown((dropdown) => {
				for (const mode of Object.keys(MODE_LABEL) as GlossMode[]) {
					dropdown.addOption(mode, MODE_LABEL[mode]);
				}
				dropdown.setValue(settings.mode).onChange(async (value) => {
					settings.mode = value as GlossMode;
					await this.persist();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('目标语言')
			.addDropdown((dropdown) => {
				for (const code of Object.keys(LANG_LABEL)) {
					dropdown.addOption(code, LANG_LABEL[code]);
				}
				dropdown.setValue(settings.targetLang).onChange(async (value) => {
					settings.targetLang = value;
					await this.persist();
				});
			});

		new Setting(containerEl)
			.setName('关键词条数上限')
			.setDesc('每个段落最多保留多少个词条，默认 20。候选词数量会跟着它放宽。')
			.addSlider((slider) =>
				slider
					.setLimits(3, 40, 1)
					.setValue(settings.maxItems)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.maxItems = Math.round(value);
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('单次输入字符上限')
			.setDesc('超过后会按句子截断并提示；默认 4000，约两三段。')
			.addText((text) =>
				text.setValue(String(settings.maxInputChars)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					settings.maxInputChars = Math.min(20000, Math.max(200, parsed));
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('整理词义')
			.setDesc('关掉后只生成译文、不调用词义模型（更快，但只剩一段中文）。')
			.addToggle((toggle) =>
				toggle.setValue(settings.includeItems).onChange(async (value) => {
					settings.includeItems = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('块内显示原文')
			.setDesc('打开后每个词义块会重复一遍原文，便于脱离上下文阅读。')
			.addToggle((toggle) =>
				toggle.setValue(settings.showSourceInBlock).onChange(async (value) => {
					settings.showSourceInBlock = value;
					await this.persist();
				}),
			);
	}

	private renderGlossarySection(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		containerEl.createEl('h3', { text: '术语表' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '每行一条：英文=中文。这里的内容会覆盖内置的强化学习术语表；内置表已经包含 policy=策略、reward=奖励 等常用词。',
		});

		new Setting(containerEl)
			.setName('自定义术语（追加/覆盖）')
			.addTextArea((area) => {
				area
					.setPlaceholder('policy=策略\nvalue function=价值函数')
					.setValue(settings.customGlossary)
					.onChange(async (value) => {
						settings.customGlossary = value;
						await this.persist();
					});
				area.inputEl.rows = 8;
				area.inputEl.addClass('ig-glossary-input');
			})
			.addButton((button) =>
				button.setButtonText('填入默认表').onClick(async () => {
					settings.customGlossary = defaultGlossaryText();
					await this.persist();
					this.display();
				}),
			)
			.addButton((button) =>
				button.setButtonText('清空').onClick(async () => {
					settings.customGlossary = '';
					await this.persist();
					this.display();
				}),
			);
	}

	private renderPdfSection(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		containerEl.createEl('h3', { text: 'PDF' });

		new Setting(containerEl)
			.setName('把缓存写进 vault（sidecar JSON）')
			.setDesc(
				'默认打开：词义记录会写成 vault 里的 JSON 文件，随 vault 同步、换设备也在。关闭则只存在 localStorage（不产生文件，但换机器或清缓存后会丢）。',
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.pdfCacheInVault).onChange(async (value) => {
					settings.pdfCacheInVault = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('缓存文件夹')
			.setDesc('留空表示放在 PDF 同目录；填 Glosses/pdf 这类相对路径则集中存放。')
			.addText((text) =>
				text
					.setPlaceholder('留空 = PDF 同目录')
					.setValue(settings.pdfCacheFolder)
					.onChange(async (value) => {
						settings.pdfCacheFolder = value.trim();
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('使用说明')
			.setDesc(
				'打开 PDF 后按 Ctrl/Cmd+P 执行「Open PDF gloss sidebar」，在正文里划词，然后点侧栏的「译选中」。页码读不到时会显示 P?，不影响保存。',
			);
	}

	private renderWordMarkSection(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		containerEl.createEl('h3', { text: 'PDF 词级标注' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: '选中一个单词后，原词出现高亮，中文标签尽量塞进两行文字之间的空隙。标注单独保存在 .marks.json，不修改 PDF 本身。',
		});

		new Setting(containerEl)
			.setName('启用词级标注')
			.setDesc('关掉后只保留高亮层的开关状态，已有标注数据不会被删除。')
			.addToggle((toggle) =>
				toggle.setValue(settings.pdfMarksEnabled).onChange(async (value) => {
					settings.pdfMarksEnabled = value;
					await this.persist();
					this.plugin.syncOverlay();
				}),
			);

		new Setting(containerEl)
			.setName('优先使用离线英汉词典')
			.setDesc('内置 ECDICT 精简词库（约 3.7 万常用词，MIT）；命中时不请求模型，直接给出多条中文释义。')
			.addToggle((toggle) =>
				toggle.setValue(settings.offlineDictionaryEnabled).onChange(async (value) => {
					settings.offlineDictionaryEnabled = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('词典未收录时用模型补')
			.setDesc('关闭后，词典查不到的词只提示“未收录”，不会再把生词交给模型猜。')
			.addToggle((toggle) =>
				toggle.setValue(settings.offlineDictionaryFallback).onChange(async (value) => {
					settings.offlineDictionaryFallback = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('多义词用 AI 选义项')
			.setDesc('词典有多个候选义项时，让义项模型只输出最合适的一项编号；单义词不调用模型。')
			.addToggle((toggle) =>
				toggle.setValue(settings.offlineSenseSelection).onChange(async (value) => {
					settings.offlineSenseSelection = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('义项选择模型')
			.setDesc('只做“从候选里选编号”，推荐 qwen2.5:3b；留空则用「词义模型」。')
			.addText((text) =>
				text
					.setPlaceholder('qwen2.5:3b')
					.setValue(settings.pdfMarkSenseModel)
					.onChange(async (value) => {
						settings.pdfMarkSenseModel = value.trim();
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('词标注模型（仅兜底）')
			.setDesc('只有词典未收录且允许模型兜底时才用；留空则用上面的「词义模型」。')
			.addText((text) =>
				text
					.setPlaceholder('qwen2.5:3b')
					.setValue(settings.pdfMarkModel)
					.onChange(async (value) => {
						settings.pdfMarkModel = value.trim();
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('标注时保存整句翻译')
			.setDesc('每次标注词/短语时，用句子模型翻译它所在的整句，存进 .marks.json；右侧栏和编辑框可查看。关掉可省一次模型请求。')
			.addToggle((toggle) =>
				toggle.setValue(settings.pdfMarkTranslateSentence).onChange(async (value) => {
					settings.pdfMarkTranslateSentence = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('释义显示方式')
			.setDesc(
				'hover（默认）：平时只有高亮，鼠标停在标注过的词上才冒出中文，不压任何正文。none：只高亮，不显示浮标。gap / overlap / margin：常驻标签，会占行间空隙或压到下一行。',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('hover', 'hover（悬停显示，不压字）')
					.addOption('none', 'none（只高亮）')
					.addOption('gap', 'gap（塞行间）')
					.addOption('overlap', 'overlap（压下一行）')
					.addOption('margin', 'margin（贴页边）')
					.setValue(settings.pdfMarkLabelMode)
					.onChange(async (value) => {
						settings.pdfMarkLabelMode = value as typeof settings.pdfMarkLabelMode;
						await this.persist();
						this.plugin.syncOverlay();
					}),
			);

		new Setting(containerEl)
			.setName('悬停标签字号缩放')
			.setDesc('1 表示跟随页面行高；只想看个大概可以调到 0.8，想看得更大就 1.2–1.5。')
			.addSlider((slider) =>
				slider
					.setLimits(0.6, 2, 0.05)
					.setValue(settings.pdfMarkFontScale)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.pdfMarkFontScale = value;
						await this.persist();
						this.plugin.syncOverlay();
					}),
			);

		new Setting(containerEl)
			.setName('高亮颜色')
			.setDesc('标签与高亮共用这套颜色。')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('yellow', '黄色')
					.addOption('green', '绿色')
					.addOption('blue', '蓝色')
					.addOption('pink', '粉色')
					.setValue(settings.pdfMarkColor)
					.onChange(async (value) => {
						settings.pdfMarkColor = value as typeof settings.pdfMarkColor;
						await this.persist();
						this.plugin.syncOverlay();
					}),
			);

		new Setting(containerEl)
			.setName('高亮不透明度')
			.setDesc('0.9 接近荧光笔；1 最容易看见，但会盖住字形细节。')
			.addSlider((slider) =>
				slider
					.setLimits(0.2, 1, 0.05)
					.setValue(settings.pdfMarkOpacity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.pdfMarkOpacity = value;
						await this.persist();
						this.plugin.syncOverlay();
					}),
			);

		new Setting(containerEl)
			.setName('标签里显示词性')
			.setDesc('打开后标签显示成「相关的 adj.」，占位更宽。')
			.addToggle((toggle) =>
				toggle.setValue(settings.pdfMarkShowPos).onChange(async (value) => {
					settings.pdfMarkShowPos = value;
					await this.persist();
					this.plugin.syncOverlay();
				}),
			);

		new Setting(containerEl)
			.setName('选中内容字符上限')
			.setDesc('超过这个长度就提示「请选一个词或短语」，避免把整句当单词翻译。')
			.addSlider((slider) =>
				slider
					.setLimits(10, 80, 5)
					.setValue(settings.pdfMarkMaxChars)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.pdfMarkMaxChars = Math.round(value);
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('标注写进 vault')
			.setDesc(
				'默认打开：写到 Glosses/pdf/<书名>-<短 hash>.marks.json，和段落词义记录分开。关闭则只存在 localStorage。',
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.pdfMarkCacheInVault).onChange(async (value) => {
					settings.pdfMarkCacheInVault = value;
					await this.persist();
				}),
			);

		new Setting(containerEl)
			.setName('标注文件夹')
			.setDesc('留空表示放在 PDF 同目录。')
			.addText((text) =>
				text
					.setPlaceholder('Glosses/pdf')
					.setValue(settings.pdfMarkCacheFolder)
					.onChange(async (value) => {
						settings.pdfMarkCacheFolder = value.trim();
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName('用法')
			.setDesc(
				'选中一个词 → 命令「Mark PDF word（标注 PDF 选中词）」，或点侧栏的「标注选中词」。点标签可改释义；侧栏「词标注」列表可定位、编辑、删除。',
			);
	}

	private renderDiagnosticsSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: '诊断' });

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('列出模型即代表服务可用；失败时会给出具体原因。')
			.addButton((button) =>
				button.setButtonText('测试').onClick(async () => {
					if (this.testing) return;
					this.testing = true;
					button.setDisabled(true);
					try {
						const models = await this.plugin.listModels();
						this.modelList = models;
						new Notice(
							models.length
								? `连接正常，${models.length} 个模型可用`
								: '连接成功，但没有可用模型',
							6000,
						);
					} catch (error) {
						new Notice(
							`连接失败：${error instanceof Error ? error.message : String(error)}`,
							8000,
						);
					} finally {
						this.testing = false;
						button.setDisabled(false);
					}
				}),
			)
			.addButton((button) =>
				button.setButtonText('诊断信息').onClick(() => {
					void this.plugin.runDiagnostics();
				}),
			);

		new Setting(containerEl)
			.setName('恢复默认输出设置')
			.setDesc('只重置输出模式、关键词上限和输入上限，不动服务商与模型。')
			.addButton((button) =>
				button.setButtonText('恢复').onClick(async () => {
					const settings = this.plugin.settings;
					settings.mode = 'keywords';
					settings.maxItems = 20;
					settings.maxInputChars = 4000;
					await this.persist();
					this.display();
					new Notice('已恢复默认输出设置');
				}),
			);
	}
}
