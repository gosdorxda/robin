declare module "bs58" {
  export function encode(bytes: Uint8Array | number[]): string;
  export function decode(str: string): Uint8Array;
}
