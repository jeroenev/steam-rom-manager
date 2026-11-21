// Parser results (what FileParser gives PreviewBuilder) made by hand, and the
// preview list PreviewBuilder makes of them: for what the builder does across
// parsers, such as with Store Account parsers' games.
import * as path from "path";
import { BuildResult, PreviewBuilder } from "../../src/core/preview-builder";
import {
  AppSettings,
  ParsedUserConfiguration,
  ParsedUserConfigurationFile,
  ParserType,
  initArtworkRecord,
  userAccountData,
} from "../../src/models";
import { makeSettings } from "./fixtures";

export const ALICE = { accountID: "11111111", name: "alice", steamID64: "" };
export const BOB = { accountID: "22222222", name: "bob", steamID64: "" };

export function parsedFile(
  exe: string,
  title: string,
  args: string,
  categories: string[],
): ParsedUserConfigurationFile {
  return {
    executableLocation: exe,
    modifiedExecutableLocation: `"${exe}"`,
    startInDirectory: path.win32.dirname(exe),
    filePath: exe,
    titles: {
      extracted: title,
      fuzzy: title,
      final: title,
    } as unknown as ParsedUserConfigurationFile["titles"],
    sortAsTitle: "",
    argumentString: args,
    compatToolName: "",
    appendArgsToExecutable: false,
    onlineImageQueries: [title],
    steamCategories: categories,
    imagePool: title,
    defaultImage: initArtworkRecord(() => undefined as any),
    backupImage: initArtworkRecord(() => undefined as any),
    localImages: initArtworkRecord(() => [] as string[]),
    resolvedDefaultImages: initArtworkRecord(() => [] as string[]),
    resolvedLocalImages: initArtworkRecord(() => [] as string[]),
  };
}

export function parsedConfig(
  steamDirectory: string,
  parserType: ParserType,
  parserId: string,
  files: ParsedUserConfigurationFile[],
  accounts: userAccountData[] = [ALICE],
  extra: Partial<ParsedUserConfiguration> = {},
): ParsedUserConfiguration {
  return {
    configurationTitle: parserId,
    parserId,
    parserType,
    drmProtect: false,
    imageProviders: [],
    imageProviderAPIs: { sgdb: {}, steamCDN: {} } as any,
    controllers: {} as any,
    steamInputEnabled: "1" as any,
    steamDirectory,
    shortcutPassthrough: false,
    overlayImages: initArtworkRecord(() => ""),
    foundUserAccounts: accounts,
    missingUserAccounts: [],
    files,
    failed: [],
    excluded: [],
    ...extra,
  };
}

// Builds the preview of `configs` (as if the parsers had just given them)
// with `settings`; `logged` has what it logged.
export async function buildPreview(
  configs: ParsedUserConfiguration[],
  settings: AppSettings = makeSettings({
    previewSettings: { retrieveCurrentSteamImages: false },
  }),
): Promise<{ result: BuildResult; logged: string[] }> {
  const logged: string[] = [];
  const parsed = {
    parsedData: { parsedConfigs: configs, noUserAccounts: false },
    skipped: [] as string[],
    invalid: [] as string[],
    reparsed: configs.length,
  };
  const builder = new PreviewBuilder(
    { info: (message: any) => logged.push(String(message)) } as any,
    {
      executeFileParser: async () => parsed,
      executeFileParserReusing: async () => parsed,
      getAll: (): unknown[] => [],
    } as any,
    { get: () => settings } as any,
  );
  return { result: await builder.build(), logged };
}
