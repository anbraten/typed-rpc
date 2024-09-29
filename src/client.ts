import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcTranscoder,
} from "./types.js";

export * from "./types.js";

/**
 * Error class that is thrown if a remote method returns an error.
 */
export class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
    // https://www.typescriptlang.org/docs/handbook/2/classes.html#inheriting-built-in-types
    Object.setPrototypeOf(this, RpcError.prototype);
  }
}

/**
 * Interface for custom transports. Implementations are expected to serialize
 * the given request and return an object that is a JsonRpcResponse.
 */
export type RpcTransport = (
  req: any,
  abortSignal: AbortSignal
) => Promise<JsonRpcResponse | void>;

type RpcClientOptions =
  | string
  | (FetchOptions & {
      transport?: RpcTransport;
      transcoder?: RpcTranscoder<any>;
    });

type FetchOptions = {
  url: string;
  credentials?: RequestCredentials;
  getHeaders?():
    | Record<string, string>
    | Promise<Record<string, string>>
    | undefined;
};

type Promisify<T> = T extends (...args: any[]) => Promise<any>
  ? T // already a promise
  : T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<R>
  : T; // not a function;

type PromisifyMethods<T extends object> = {
  [K in keyof T]: Promisify<T[K]>;
};

const identityTranscoder: RpcTranscoder<string> = {
  serialize: (data) => JSON.stringify(data),
  deserialize: (data) => JSON.parse(data),
};

export function rpcClient<T extends object>(options: RpcClientOptions) {
  if (typeof options === "string") {
    options = { url: options };
  }
  const transport = options.transport || fetchTransport(options);
  const { serialize, deserialize } = options.transcoder || identityTranscoder;

  /**
   * Send a request using the configured transport and handle the result.
   */
  const sendRequest = async (
    method: string,
    args: any[] = [],
    id: JsonRpcRequest['id'],
    signal: AbortSignal = new AbortController().signal,
  ) => {
    const req = createRequest(method, args, id);
    const raw = await transport(serialize(req as any), signal);
    console.log('raw', raw);
    const res = raw !== undefined ? deserialize(raw) : undefined;
    if (typeof res === "object" && "result" in res) {
      return res.result;
    }

    if (typeof res === "object" && "error" in res) {
      const { code, message, data } = res.error;
      throw new RpcError(message, code, data);
    }

    if (id === undefined) {
      // We don't expect a response for notifications
      return;
    }
    throw new TypeError("Invalid response");
  };

  // Map of AbortControllers to abort pending requests
  const abortControllers = new WeakMap<Promise<any>, AbortController>();

  const target = {
    /**
     * Send a notification to the server.
     */
    $notify: (method: string, args: any[] = [], signal?: AbortSignal ) => sendRequest(method, args, undefined, signal),
    /**
     * Send a request to the server.
     */
    $request: (method: string, args: any[] = [], signal?: AbortSignal) => sendRequest(method, args, Date.now(), signal),
    /**
     * Abort the request for the given promise.
     */
    $abort: (promise: Promise<any>) => {
      const ac = abortControllers.get(promise);
      ac?.abort();
    },
  };

  return new Proxy(target, {
    /* istanbul ignore next */
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === "symbol") return;
      if (prop === "toJSON") return;
      return (...args: any) => {
        const ac = new AbortController();
        const promise = sendRequest(prop.toString(), args, Date.now(), ac.signal);
        abortControllers.set(promise, ac);
        promise
          .finally(() => {
            // Remove the
            abortControllers.delete(promise);
          })
          .catch(() => {});
        return promise;
      };
    },
  }) as typeof target & PromisifyMethods<T>;
}

/**
 * Create a JsonRpcRequest for the given method.
 */
export function createRequest(method: string, params?: any[], id?: JsonRpcRequest['id']): JsonRpcRequest {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
  };

  if (id) {
    request.id = id;
  }

  if (params?.length) {
    request.params = removeTrailingUndefs(params);
  }

  return request;
}

/**
 * Returns a shallow copy of the given array without any
 * trailing `undefined` values.
 */
export function removeTrailingUndefs(values: any[]) {
  const a = [...values];
  while (a.length && a[a.length - 1] === undefined) a.length--;
  return a;
}

/**
 * Create a RpcTransport that uses the global fetch.
 */
export function fetchTransport(options: FetchOptions): RpcTransport {
  return async (req: any, signal: AbortSignal): Promise<any> => {
    const headers = options?.getHeaders ? await options.getHeaders() : {};
    const res = await fetch(options.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers,
      },
      body: req,
      credentials: options?.credentials,
      signal,
    });

    if (!res.ok) {
      throw new RpcError(res.statusText, res.status);
    }

    return await res.text();
  };
}
