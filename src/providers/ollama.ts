import type { HttpTransport, HttpResponse } from './transport';
import { ChatOptions, ProviderError, TranslationProvider, fromTransportError } from './provider';

interface OllamaChatResponse {
	message?: { role?: string; content?: string };
	response?: string;
	error?: string;
	model?: string;
}

function trimBaseUrl(baseUrl: string): string {
	const url = (baseUrl || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
	return url.replace(/\/api$/, '');
}

export class OllamaProvider implements TranslationProvider {
	readonly id = 'ollama';
	readonly label = 'Ollama';
	private readonly baseUrl: string;

	constructor(private readonly transport: HttpTransport, baseUrl: string) {
		this.baseUrl = trimBaseUrl(baseUrl);
	}

	async chat(options: ChatOptions): Promise<string> {
		let response: HttpResponse;
		try {
			response = await this.transport.request({
				url: `${this.baseUrl}/api/chat`,
				method: 'POST',
				body: {
					model: options.model,
					messages: options.messages,
					stream: false,
					keep_alive: '30m',
					options: {
						temperature: options.temperature,
						num_ctx: options.numCtx ?? 8192,
						num_predict: options.maxTokens,
					},
				},
				timeoutMs: options.timeoutMs,
			});
		} catch (error) {
			throw fromTransportError(error, this.baseUrl);
		}

		let payload: OllamaChatResponse = {};
		try {
			payload = JSON.parse(response.text) as OllamaChatResponse;
		} catch {
			payload = {};
		}

		if (response.status >= 400) {
			const detail = payload.error || response.text.slice(0, 300);
			if (response.status === 404 || /not found|no such model|pull/i.test(detail)) {
				throw new ProviderError(
					`Ollama 中没有模型「${options.model}」。先运行：ollama pull ${options.model}`,
					'model',
					detail,
					false,
				);
			}
			throw new ProviderError(`Ollama 返回 ${response.status}：${detail}`, 'http', detail, response.status >= 500);
		}

		const content = payload.message?.content ?? payload.response ?? '';
		if (!content.trim()) {
			throw new ProviderError('Ollama 返回了空内容（可能是 num_predict 太小或模型加载失败）', 'parse', response.text.slice(0, 300), true);
		}
		return content;
	}

	async listModels(): Promise<string[]> {
		try {
			const response = await this.transport.request({
				url: `${this.baseUrl}/api/tags`,
				method: 'GET',
				timeoutMs: 15000,
			});
			if (response.status >= 400) {
				throw new ProviderError(`Ollama 返回 ${response.status}`, 'http', response.text.slice(0, 200));
			}
			const payload = JSON.parse(response.text) as { models?: { name?: string }[] };
			return (payload.models ?? []).map((model) => model.name ?? '').filter(Boolean);
		} catch (error) {
			throw fromTransportError(error, this.baseUrl);
		}
	}
}
