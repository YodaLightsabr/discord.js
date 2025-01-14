import { VoiceOpcodes } from 'discord-api-types/voice/v4';
import WebSocket, { MessageEvent } from 'ws';
import { TypedEmitter } from 'tiny-typed-emitter';
import type { Awaited } from '../util/util';

/**
 * Debug event for VoiceWebSocket.
 *
 * @event VoiceWebSocket#debug
 * @type {string}
 */

export interface VoiceWebSocketEvents {
	error: (error: Error) => Awaited<void>;
	open: (event: WebSocket.Event) => Awaited<void>;
	close: (event: WebSocket.CloseEvent) => Awaited<void>;
	debug: (message: string) => Awaited<void>;
	packet: (packet: any) => Awaited<void>;
}

/**
 * An extension of the WebSocket class to provide helper functionality when interacting
 * with the Discord Voice gateway.
 */
export class VoiceWebSocket extends TypedEmitter<VoiceWebSocketEvents> {
	/**
	 * The current heartbeat interval, if any.
	 */
	private heartbeatInterval?: NodeJS.Timeout;

	/**
	 * The time (milliseconds since UNIX epoch) that the last heartbeat acknowledgement packet was received.
	 * This is set to 0 if an acknowledgement packet hasn't been received yet.
	 */
	private lastHeartbeatAck: number;

	/**
	 * The time (milliseconds since UNIX epoch) that the last heartbeat was sent. This is set to 0 if a heartbeat
	 * hasn't been sent yet.
	 */
	private lastHeatbeatSend: number;

	/**
	 * The number of consecutively missed heartbeats.
	 */
	private missedHeartbeats = 0;

	/**
	 * The last recorded ping.
	 */
	public ping?: number;

	/**
	 * The debug logger function, if debugging is enabled.
	 */
	private readonly debug: null | ((message: string) => void);

	/**
	 * The underlying WebSocket of this wrapper.
	 */
	private readonly ws: WebSocket;

	/**
	 * Creates a new VoiceWebSocket.
	 *
	 * @param address - The address to connect to
	 */
	public constructor(address: string, debug: boolean) {
		super();
		this.ws = new WebSocket(address);
		this.ws.onmessage = (e) => this.onMessage(e);
		this.ws.onopen = (e) => this.emit('open', e);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		this.ws.onerror = (e: Error | WebSocket.ErrorEvent) => this.emit('error', e instanceof Error ? e : e.error);
		this.ws.onclose = (e) => this.emit('close', e);

		this.lastHeartbeatAck = 0;
		this.lastHeatbeatSend = 0;

		this.debug = debug ? (message: string) => this.emit('debug', message) : null;
	}

	/**
	 * Destroys the VoiceWebSocket. The heartbeat interval is cleared, and the connection is closed.
	 */
	public destroy() {
		try {
			this.debug?.('destroyed');
			this.setHeartbeatInterval(-1);
			this.ws.close(1000);
		} catch (error) {
			const e = error as Error;
			this.emit('error', e);
		}
	}

	/**
	 * Handles message events on the WebSocket. Attempts to JSON parse the messages and emit them
	 * as packets.
	 *
	 * @param event - The message event
	 */
	public onMessage(event: MessageEvent) {
		if (typeof event.data !== 'string') return;

		this.debug?.(`<< ${event.data}`);

		let packet: any;
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			packet = JSON.parse(event.data);
		} catch (error) {
			const e = error as Error;
			this.emit('error', e);
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		if (packet.op === VoiceOpcodes.HeartbeatAck) {
			this.lastHeartbeatAck = Date.now();
			this.missedHeartbeats = 0;
			this.ping = this.lastHeartbeatAck - this.lastHeatbeatSend;
		}

		/**
		 * Packet event.
		 *
		 * @event VoiceWebSocket#packet
		 * @type {any}
		 */
		this.emit('packet', packet);
	}

	/**
	 * Sends a JSON-stringifiable packet over the WebSocket.
	 *
	 * @param packet - The packet to send
	 */
	public sendPacket(packet: any) {
		try {
			const stringified = JSON.stringify(packet);
			this.debug?.(`>> ${stringified}`);
			return this.ws.send(stringified);
		} catch (error) {
			const e = error as Error;
			this.emit('error', e);
		}
	}

	/**
	 * Sends a heartbeat over the WebSocket.
	 */
	private sendHeartbeat() {
		this.lastHeatbeatSend = Date.now();
		this.missedHeartbeats++;
		const nonce = this.lastHeatbeatSend;
		return this.sendPacket({
			op: VoiceOpcodes.Heartbeat,
			d: nonce,
		});
	}

	/**
	 * Sets/clears an interval to send heartbeats over the WebSocket.
	 *
	 * @param ms - The interval in milliseconds. If negative, the interval will be unset
	 */
	public setHeartbeatInterval(ms: number) {
		if (typeof this.heartbeatInterval !== 'undefined') clearInterval(this.heartbeatInterval);
		if (ms > 0) {
			this.heartbeatInterval = setInterval(() => {
				if (this.lastHeatbeatSend !== 0 && this.missedHeartbeats >= 3) {
					// Missed too many heartbeats - disconnect
					this.ws.close();
					this.setHeartbeatInterval(-1);
				}
				this.sendHeartbeat();
			}, ms);
		}
	}
}
