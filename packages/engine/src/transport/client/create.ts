/**
 * Lớp bọc quanh Agent client đã sinh, có route theo directory/workspace.
 * GET/HEAD headers được rewrite thành query để tương thích SSE/cache/proxy.
 * @module
 */
export * from "./generated/types.gen.js";
export type { FileSystemEntry as LocationFileSystemEntry } from "./generated/types.gen.js";

import { createClient } from "./generated/client/client.gen.js";
import { type Config } from "./generated/client/types.gen.js";
import { PhinsClient } from "./generated/sdk.gen.js";
import { wrapClientError } from "./errors.js";
export {
  type Config as PHINsClientConfig,
  PhinsClient,
  PhinsClient as PHINsClient,
};

function pick(
  value: string | null,
  fallback?: string,
  encode?: (value: string) => string,
) {
  if (!value) return;
  if (!fallback) return value;
  if (value === fallback) return fallback;
  if (encode && value === encode(fallback)) return fallback;
  return value;
}

function rewrite(
  request: Request,
  values: { directory?: string; workspace?: string },
) {
  if (request.method !== "GET" && request.method !== "HEAD") return request;

  const url = new URL(request.url);
  let changed = false;

  for (const [name, key] of [
    ["x-phins-directory", "directory"],
    ["x-phins-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    );
    if (!value) continue;
    for (const query of url.pathname.startsWith("/api/")
      ? [key, `location[${key}]`]
      : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value);
      }
    }
    changed = true;
  }

  if (!changed) return request;

  const next = new Request(url, request);
  next.headers.delete("x-phins-directory");
  next.headers.delete("x-phins-workspace");
  return next;
}

/** Tạo client và cài request/response/error interceptors. */
export function createPHINsClient(
  config?: Config & { directory?: string; experimental_workspaceID?: string },
) {
  const options = { ...config };

  if (!options.fetch) {
    const customFetch = ((req: Request) => {
      const request = req as Request & { timeout?: boolean };
      request.timeout = false;
      return fetch(request);
    }) as Config["fetch"];
    options.fetch = customFetch;
  }

  if (options.directory || options.experimental_workspaceID) {
    const headers = new Headers(options.headers as HeadersInit | undefined);
    if (options.directory) {
      headers.set("x-phins-directory", encodeURIComponent(options.directory));
    }
    if (options.experimental_workspaceID) {
      headers.set("x-phins-workspace", options.experimental_workspaceID);
    }
    options.headers = headers;
  }

  const client = createClient(options);
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: options.directory,
      workspace: options.experimental_workspaceID,
    }),
  );
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type");
    if (contentType === "text/html")
      throw new Error(
        "Request is not supported by this version of PHINs Server (Server responded with text/html)",
      );

    return response;
  });
  client.interceptors.error.use(wrapClientError);
  return new PhinsClient({ client });
}
