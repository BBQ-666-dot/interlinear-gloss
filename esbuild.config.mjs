import esbuild from 'esbuild';
import process from 'node:process';

const target = process.argv[2] ?? 'dev';
const production = target === 'production';

const shared = {
	bundle: true,
	logLevel: 'info',
	target: 'es2018',
	sourcemap: production ? false : 'inline',
	minify: production,
	loader: { '.tsv': 'text' },
};

async function buildPlugin() {
	await esbuild.build({
		...shared,
		entryPoints: ['src/main.ts'],
		outfile: 'main.js',
		format: 'cjs',
		platform: 'browser',
		external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
	});
}

async function buildTests() {
	await esbuild.build({
		bundle: true,
		entryPoints: ['test/run.ts'],
		outfile: 'test/run.cjs',
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		alias: { obsidian: './test/obsidian-stub.ts' },
		sourcemap: 'inline',
		logLevel: 'info',
		loader: { '.tsv': 'text' },
	});
}

if (target === 'test') {
	await buildTests();
} else {
	await buildPlugin();
}
