/**
 * Latency probe: how long does one paragraph take, and how much of it is the
 * glossary pass? Not part of `npm test`; run manually:
 *
 *   npx esbuild test/latency.ts --bundle --platform=node --format=cjs `
 *     --outfile=test/latency.cjs --alias:obsidian=./test/obsidian-stub.ts
 *   node test/latency.cjs
 */
import { generateGloss } from '../src/gloss/engine';
import { createProvider } from '../src/providers/provider';
import { FetchTransport } from '../src/providers/transport';
import { DEFAULT_SETTINGS } from '../src/settings';

const SAMPLE = `The bandit problem lies at the heart of reinforcement learning. We use it to illustrate how an agent can learn from data even when it cannot foresee the future. Understanding this problem is essential for grasping the more complex scenarios that follow.`;

async function run(label: string, includeItems: boolean): Promise<void> {
	const settings = { ...DEFAULT_SETTINGS, includeItems, qualityFallback: false };
	const provider = createProvider(settings, new FetchTransport(), '');
	const started = Date.now();
	const result = await generateGloss(SAMPLE, { provider, settings });
	const elapsed = Date.now() - started;
	console.log(
		`${label}: ${elapsed}ms  items=${result.data.items.length}  chars=${result.data.translation.length}`,
	);
}

async function main(): Promise<void> {
	await run('译文 only', false);
	await run('译文 + 词义', true);
	await run('译文 + 词义（二次）', true);
}

void main();
