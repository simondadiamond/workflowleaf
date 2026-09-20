/**
 * The WebSocket connection to a T3 server.
 *
 * WorkflowLeaf speaks the protocol the web client speaks, over the same
 * authenticated socket, using only methods the server already exposes. It edits
 * no upstream file, so bootstrap, permissions, checkpointing and worktree
 * ownership all stay T3's.
 *
 * The full client session is deliberately not reused: it also negotiates
 * environment identity and maintains a server-config subscription, none of
 * which a headless run needs. What is reused is the protocol client itself, so
 * the wire contract is the same one the UI uses rather than a second
 * interpretation of it.
 */
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export class T3ConnectionError extends Schema.TaggedError<T3ConnectionError>()(
  "WlT3ConnectionError",
  { stage: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.stage}: ${this.detail}`;
  }
}

const TicketResponse = Schema.Struct({ ticket: Schema.String });
const decodeTicket = Schema.decodeUnknownResult(TicketResponse);

/**
 * Exchanges the profile's bearer token for a short-lived socket ticket.
 *
 * The server hands tickets out over HTTP because a browser cannot set headers
 * on a WebSocket handshake. A headless client goes the same way rather than
 * inventing a second authentication path.
 */
export const webSocketTicket = Effect.fnUntraced(function* (
  origin: string,
  token: Redacted.Redacted<string>,
) {
  const client = yield* HttpClient.HttpClient;

  const response = yield* client
    .execute(
      HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`),
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new T3ConnectionError({ stage: "request a socket ticket", detail: String(cause) }),
      ),
    );

  if (response.status !== 200) {
    return yield* new T3ConnectionError({
      stage: "request a socket ticket",
      detail: `the server answered ${response.status}. Check the token named by the profile.`,
    });
  }

  const body = yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new T3ConnectionError({ stage: "read the ticket response", detail: String(cause) }),
    ),
  );

  const decoded = decodeTicket(body);
  if (decoded._tag === "Failure") {
    return yield* new T3ConnectionError({
      stage: "read the ticket response",
      detail: decoded.failure.message,
    });
  }

  return decoded.success.ticket;
});

export function socketUrlFor(origin: string, ticket: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

/**
 * Opens an authenticated protocol client, scoped to the caller.
 *
 * Reconnection is not attempted here. A dropped socket surfaces as a failure so
 * the run reconciles against the server rather than continuing on a connection
 * whose delivery guarantees nobody has checked.
 */
export const connect = Effect.fnUntraced(function* (
  origin: string,
  token: Redacted.Redacted<string>,
) {
  const ticket = yield* webSocketTicket(origin, token);
  const constructor = yield* Socket.WebSocketConstructor;

  const socketLayer = Socket.layerWebSocket(socketUrlFor(origin, ticket), {
    openTimeout: "15 seconds",
  }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, constructor)));

  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));

  const context = yield* Layer.build(protocolLayer).pipe(
    Effect.mapError(
      (cause) => new T3ConnectionError({ stage: "open the socket", detail: String(cause) }),
    ),
  );

  return (yield* makeWsRpcProtocolClient.pipe(
    Effect.provide(context),
    Effect.mapError(
      (cause) =>
        new T3ConnectionError({ stage: "start the protocol client", detail: String(cause) }),
    ),
  )) as WsRpcProtocolClient;
});
