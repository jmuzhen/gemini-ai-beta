import { Command } from "./types";

import type {
	ChatAskOptions,
	ChatOptions,
	CommandOptionMap,
	CommandResponseMap,
	Format,
	FormatType,
	GeminiOptions,
	GeminiResponse,
	Message,
	Part,
	QueryBodyMap,
	QueryResponseMap,
} from "./types";

import { getFileType, handleReader, pairToMessage } from "./utils";

const uploadFile = async ({
	file,
	mimeType,
	gemini,
}: {
	file: Uint8Array | ArrayBuffer;
	mimeType: string;
	gemini: Gemini;
}) => {
	const BASE_URL = "https://generativelanguage.googleapis.com";

	function generateBoundary() {
		let str = "";
		for (let i = 0; i < 2; i++) {
			str = str + Math.random().toString().slice(2);
		}
		return str;
	}

	const boundary = generateBoundary();

	const generateBlob = (
		boundary: string,
		file: Uint8Array | ArrayBuffer,
		mime: string
	) =>
		new Blob([
			`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(
				{
					file: {
						mimeType: mime,
					},
				}
			)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
			file,
			`\r\n--${boundary}--`,
		]);

	const fileSendDataRaw = await gemini
		.fetch(`${BASE_URL}/upload/${gemini.apiVersion}/files?key=${gemini.key}`, {
			method: "POST",
			headers: {
				"Content-Type": `multipart/related; boundary=${boundary}`,
				"X-Goog-Upload-Protocol": "multipart",
			},
			body: generateBlob(boundary, file, mimeType),
		})
		.then((res: Response) => res.json());

	console.log(fileSendDataRaw);

	const fileSendData = fileSendDataRaw.file;

	let waitTime = 250; // Initial wait time in milliseconds
	const MAX_BACKOFF = 5000; // Maximum backoff time in milliseconds

	// Keep polling until the file state is "ACTIVE"
	while (true) {
		try {
			const url = `${BASE_URL}/${gemini.apiVersion}/${fileSendData.name}?key=${gemini.key}`;

			const response = await gemini.fetch(url, { method: "GET" });
			const data = await response.json();

			if (data.error) {
				throw new Error(data.error.message);
			}

			if (data.state === "ACTIVE") break;

			await new Promise((resolve) => setTimeout(resolve, waitTime));

			waitTime = Math.min(waitTime * 1.5, MAX_BACKOFF);
		} catch (error) {
			console.error(`An error occurred: ${error.message}`);
			break;
		}
	}

	return fileSendData.uri;
};

export const messageToParts = async (
	messages: (Uint8Array | ArrayBuffer | string)[],
	gemini: Gemini
): Promise<Part[]> => {
	const parts = [];

	for (const msg of messages) {
		if (typeof msg === "string") {
			parts.push({ text: msg });
		} else if (msg instanceof ArrayBuffer || msg instanceof Uint8Array) {
			const mimeType = await getFileType(msg);
			if (!mimeType.startsWith("image")) {
				const fileURI = await uploadFile({
					file: msg,
					mimeType: mimeType,
					gemini: gemini,
				});
				parts.push({
					fileData: {
						mime_type: mimeType,
						fileUri: fileURI,
					},
				});
			} else {
				parts.push({
					inline_data: {
						mime_type: await getFileType(msg),
						data: Buffer.from(msg).toString("base64"),
					},
				});
			}
		}
	}

	return parts;
};

class Gemini {
	readonly key: string;
	readonly apiVersion: string;
	readonly fetch: typeof fetch;

	static TEXT = "text" as const;
	static JSON = "json" as const;

	constructor(key: string, options: Partial<GeminiOptions> = {}) {
		if (!options.fetch && typeof fetch !== "function") {
			throw new Error(
				"Fetch is not defined globally. Please provide a polyfill. Learn more here: https://github.com/EvanZhouDev/gemini-ai?tab=readme-ov-file#how-to-polyfill-fetch"
			);
		}

		const parsedOptions: GeminiOptions = {
			...{
				apiVersion: "v1beta",
				fetch: typeof fetch === "function" ? fetch : options.fetch,
			},
			...options,
		};

		this.key = key;
		this.fetch = parsedOptions.fetch;
		this.apiVersion = parsedOptions.apiVersion;
	}

	async query<C extends Command>(
		model: string,
		command: C,
		body: QueryBodyMap[C]
	): Promise<Response> {
		const opts = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		};

		const url = new URL(
			`https://generativelanguage.googleapis.com/${this.apiVersion}/models/${model}:${command}`
		);

		url.searchParams.append("key", this.key);
		if (command === Command.StreamGenerate)
			url.searchParams.append("alt", "sse");

		const response = await this.fetch(url.toString(), opts);

		if (!response.ok) {
			throw new Error(
				`There was an error when fetching Gemini.\n${await response.text()}`
			);
		}

		return response;
	}

	async count(
		message: string,
		options: Partial<CommandOptionMap[Command.Count]> = {}
	): Promise<CommandResponseMap[Command.Count]> {
		const parsedOptions: CommandOptionMap[Command.Count] = {
			...{
				model: "gemini-1.5-flash-latest",
			},
			...options,
		};

		const body: QueryBodyMap[Command.Count] = {
			contents: [
				{
					parts: [{ text: message }],
					role: "user",
				},
			],
		};

		const response: Response = await this.query(
			parsedOptions.model,
			Command.Count,
			body
		);

		const output: QueryResponseMap[Command.Count] = await response.json();
		return output.totalTokens;
	}

	async embed(
		message: string,
		options: Partial<CommandOptionMap[Command.Embed]> = {}
	) {
		const parsedOptions: CommandOptionMap[Command.Embed] = {
			...{
				model: "embedding-001",
			},
			...options,
		};

		const body: QueryBodyMap[Command.Embed] = {
			model: `models/${parsedOptions.model}`,
			content: {
				parts: [{ text: message }],
				role: "user",
			},
		};

		const response: Response = await this.query(
			parsedOptions.model,
			Command.Embed,
			body
		);

		const output: QueryResponseMap[Command.Embed] = await response.json();
		return output.embedding.values;
	}

	private getTextObject = (response: GeminiResponse) =>
		response.candidates[0].content.parts[0];

	private switchFormat =
		<F extends Format>(format: F = Gemini.TEXT as F) =>
		(response: GeminiResponse): FormatType<F> => {
			if (response.candidates[0].finishReason === "SAFETY") {
				throw new Error(
					`Your prompt was blocked by Google. Here are the Harm Categories: \n${JSON.stringify(
						response.candidates[0].safetyRatings,
						null,
						4
					)}`
				);
			}

			switch (format) {
				case Gemini.TEXT:
					return this.getTextObject(response).text as FormatType<F>;
				case Gemini.JSON:
					return response as FormatType<F>;
			}
		};

	private getText = this.switchFormat(Gemini.TEXT);

	private handleStream = async <F extends Format>(
		response: Response,
		format: F,
		cb: (response: FormatType<F>) => void
	) => {
		const formatter: (response: GeminiResponse) => FormatType<F> =
			this.switchFormat(format);

		let res: GeminiResponse;
		let text = "";

		await handleReader(response, (value: GeminiResponse) => {
			res = value;
			text += this.getText(value);

			cb(formatter(value));
		});

		this.getTextObject(res).text = text;

		return formatter(res);
	};

	async ask<F extends Format = typeof Gemini.TEXT>(
		message: string | (string | Uint8Array | ArrayBuffer)[] | Message,
		options: Partial<CommandOptionMap<F>[Command.Generate]> = {}
	): Promise<CommandResponseMap<F>[Command.Generate]> {
		const parsedOptions: CommandOptionMap<F>[Command.Generate] = {
			...{
				model: "gemini-1.5-flash-latest",
				temperature: 1,
				topP: 0.94,
				topK: 32,
				format: Gemini.TEXT as F,
				maxOutputTokens: 2048,
				data: [],
				messages: [],
			},
			...options,
		};

		const command = parsedOptions.stream
			? Command.StreamGenerate
			: Command.Generate;

		const contents = [
			...parsedOptions.messages.flatMap((msg: [string, string] | Message) => {
				if (Array.isArray(msg)) {
					return pairToMessage(msg);
				}
				return msg;
			}),
		];

		if (!Array.isArray(message) && typeof message !== "string") {
			if (message.role === "model")
				throw new Error("Please prompt with role as 'user'");
			contents.push(message);
		} else {
			const messageParts = [message, parsedOptions.data].flat();
			const parts = await messageToParts(messageParts, this);

			contents.push({
				parts: parts,
				role: "user",
			});
		}

		const body: QueryBodyMap[typeof command] = {
			contents,
			generationConfig: {
				temperature: parsedOptions.temperature,
				maxOutputTokens: parsedOptions.maxOutputTokens,
				topP: parsedOptions.topP,
				topK: parsedOptions.topK,
			},
		};

		const response: Response = await this.query(
			parsedOptions.model,
			command,
			body
		);

		if (parsedOptions.stream) {
			return this.handleStream(
				response,
				parsedOptions.format,
				parsedOptions.stream
			);
		}

		return this.switchFormat(parsedOptions.format)(await response.json());
	}

	createChat(options: Partial<ChatOptions> = {}) {
		return new Chat(this, options);
	}
}

class Chat {
	gemini: Gemini;
	options: ChatOptions;
	messages: Message[];

	constructor(gemini: Gemini, options?: Partial<ChatOptions>) {
		const parsedOptions: ChatOptions = {
			...{
				messages: [],
				temperature: 1,
				topP: 0.94,
				topK: 1,
				model: "gemini-1.5-flash-latest",
				maxOutputTokens: 2048,
			},
			...options,
		};

		this.gemini = gemini;
		this.options = parsedOptions;

		this.messages = parsedOptions.messages.flatMap(pairToMessage);
	}

	async ask<F extends Format = typeof Gemini.TEXT>(
		message: string | (string | Uint8Array | ArrayBuffer)[], // make this support Message
		options: Partial<ChatAskOptions<F>> = {}
	): Promise<CommandResponseMap<F>[Command.Generate]> {
		const parsedConfig: CommandOptionMap<F>[Command.Generate] = {
			...this.options,
			...{
				data: [],
				format: Gemini.TEXT as F,
			},
			...options,
		};

		if (this.messages.at(-1)?.role === "user") {
			throw new Error(
				"Gemini has not yet responded to your last message. Please ensure you are running chat commands asynchronously."
			);
		}

		try {
			const parsedMessage: Message = {
				parts: await messageToParts([message].flat(), this.gemini),
				role: "user",
			};

			const response = await this.gemini.ask(parsedMessage, {
				...parsedConfig,
				format: Gemini.JSON,
				messages: this.messages,
				stream: parsedConfig.stream
					? (res) =>
							parsedConfig.stream(
								options.format === Gemini.JSON
									? (res as FormatType<F>)
									: (res.candidates[0].content.parts[0].text as FormatType<F>)
							)
					: undefined,
			});

			this.messages.push(parsedMessage);
			this.messages.push({
				parts: response.candidates[0].content.parts,
				role: "model",
			});

			return options.format === Gemini.JSON
				? (response as FormatType<F>)
				: (response.candidates[0].content.parts[0].text as FormatType<F>);
		} catch (e) {
			throw new Error(e);
		}
	}
}

export default Gemini;

export type {
	Format,
	Message,
	Part,
	GeminiResponse,
	CommandResponseMap,
	CommandOptionMap,
	GeminiOptions,
	ChatOptions,
	ChatAskOptions,
};
