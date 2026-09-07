import { Attribution } from "ox/erc8021";

export function builderSuffix(code: string | undefined) {
  return code ? Attribution.toDataSuffix({ codes: [code] }) : undefined;
}

export const transactionDataSuffix = builderSuffix(process.env.NEXT_PUBLIC_BUILDER_CODE);
