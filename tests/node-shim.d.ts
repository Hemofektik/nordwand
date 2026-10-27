declare module "node:fs" {
    export function readFileSync(path: string): Uint8Array;
}

declare module "node:zlib" {
    export function inflateSync(data: Uint8Array): Uint8Array;
}
