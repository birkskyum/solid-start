import { deserialize, toJSONAsync } from "seroval";
import {
  CustomEventPlugin,
  DOMExceptionPlugin,
  EventPlugin,
  FormDataPlugin,
  HeadersPlugin,
  ReadableStreamPlugin,
  RequestPlugin,
  ResponsePlugin,
  URLPlugin,
  URLSearchParamsPlugin,
} from 'seroval-plugins/web';
import { createIslandReference } from "../server/islands";

class ChunkReader {
  constructor(stream) {
    this.reader = stream.getReader();
    this.buffer = '';
  }

  async next() {
    const [first, ...rest] = this.buffer.split('\n');
    // Check if there's a chunk
    if (first === '') {
      // if there's no chunk, read again
      const chunk = await this.reader.read();
      console.log(chunk);
      if (chunk.done) {
        return { done: true, value: undefined };
      }
      // repopulate the buffer
      this.buffer += new TextDecoder().decode(chunk.value);
      // retry deserialization
      return await this.next();
    } else {
      // Check if the chunk is a valid chunk
      try {
        const result = {
          done: false,
          value: deserialize(first),
        };
        // if it succeeds, remove the first valid chunk
        // from the buffer
        this.buffer = rest.join('');
        return result;
      } catch (error) {
        // otherwise, retry again with a new chunk
        const chunk = await this.reader.read();
        console.log(chunk);
        if (chunk.done) {
          return null;
        }
        this.buffer += new TextDecoder().decode(chunk.value);
        return await this.next();
      }
    }
  }

  async drain() {
    while (true) {
      const result = await this.next();
      if (result.done) {
        break;
      }
    }
  }
}

async function deserializeStream(id, response) {
  if (!response.body) {
    throw new Error("missing body");
  }
  const reader = new ChunkReader(response.body);

  const result = await reader.next();

  if (!result.done) {
    reader.drain().then(
      () => {
        delete $R[id];
      },
      () => {
        // no-op
      }
    );
  }

  return result.value;
}

let INSTANCE = 0;

function createRequest(base, id, instance, body, contentType) {
  return fetch(base, {
    method: "POST",
    headers: {
      "x-server-id": id,
      "x-server-instance": instance,
      ...(contentType ? { "Content-Type": contentType } : {})
    },
    body
  });
}

async function fetchServerFunction(base, id, args) {
  const instance = `server-fn:${INSTANCE++}`;
  const response = await (args.length === 1 && args[0] instanceof FormData
    ? createRequest(base, id, instance, args[0])
    : createRequest(base, id, instance, JSON.stringify(await Promise.resolve(toJSONAsync(args, {
      plugins: [
        CustomEventPlugin,
        DOMExceptionPlugin,
        EventPlugin,
        FormDataPlugin,
        HeadersPlugin,
        ReadableStreamPlugin,
        RequestPlugin,
        ResponsePlugin,
        URLSearchParamsPlugin,
        URLPlugin,
      ],
    }))), "application/json"));

  if (response.headers.get("Location")) throw response;
  if (response.headers.get("X-Revalidate")) {
    /* ts-ignore-next-line */
    response.customBody = () => {
      return deserializeStream(instance, response);
    }
    throw response;
  }
  const contentType = response.headers.get("Content-Type");
  let result;
  if (contentType && contentType.startsWith("text/plain")) {
    result = await response.text();
  } else if (contentType && contentType.startsWith("application/json")) {
    result = await response.json();
  } else {
    result = deserializeStream(instance, response);
  }
  if (response.ok) {
    return result;
  }
  throw result;
}

export function createServerReference(fn, id, name) {
  const baseURL = import.meta.env.SERVER_BASE_URL;
  return new Proxy(fn, {
    get(target, prop, receiver) {
      if (prop === "url") {
        return `${baseURL}/_server?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
      }
    },
    apply(target, thisArg, args) {
      return fetchServerFunction(`${baseURL}/_server`, `${id}#${name}`, args);
    }
  });
}

export function createClientReference(Component, id, name) {
  if (typeof Component === "function") {
    return createIslandReference(Component, id, name);
  }

  return Component;
}
