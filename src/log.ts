/**
 * Minimal logger. Never records the request text itself (it may contain book
 * content); only shape metrics, model names and error messages.
 */
export interface GlossLogger {
	debug(message: string, ...rest: unknown[]): void;
	warn(message: string, ...rest: unknown[]): void;
	error(message: string, ...rest: unknown[]): void;
}

const PREFIX = '[interlinear-gloss]';

export const consoleLogger: GlossLogger = {
	debug(message, ...rest) {
		if (typeof console !== 'undefined') console.debug(PREFIX, message, ...rest);
	},
	warn(message, ...rest) {
		if (typeof console !== 'undefined') console.warn(PREFIX, message, ...rest);
	},
	error(message, ...rest) {
		if (typeof console !== 'undefined') console.error(PREFIX, message, ...rest);
	},
};

export const silentLogger: GlossLogger = {
	debug() {},
	warn() {},
	error() {},
};
