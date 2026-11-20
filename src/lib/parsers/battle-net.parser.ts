import {
  ParserInfo,
  GenericParser,
  ParsedData,
  LaunchScript,
} from "../../models";
import { APP } from "../../variables";
import * as os from "os";
import * as path from "path";
import { parserScript } from "../launch-wrapper";
import {
  BATTLE_NET_PRODUCT_DB,
  BNET_GAMES,
  DEFAULT_BATTLE_NET_EXE,
  readBattleNetProducts,
} from "../helpers/launchers";

export class BattleNetParser implements GenericParser {
  private get lang() {
    return APP.lang.battleNetParser;
  }

  getParserInfo(): ParserInfo {
    return {
      title: "Battle.net",
      info: this.lang.docs__md.self.join(""),
      inputs: {
        battleExeOverride: {
          label: this.lang.battleExeOverrideTitle,
          placeholder: this.lang.battleExeOverridePlaceholder[APP.osType],
          inputType: "path",
          info: this.lang.docs__md.input.join(""),
        },
      },
    };
  }

  execute(
    directories: string[],
    inputs: { [key: string]: any },
    cache?: { [key: string]: any },
  ): Promise<ParsedData> {
    return new Promise<ParsedData>(async (resolve, reject) => {
      if (os.type() !== "Windows_NT") {
        return reject(this.lang.errors.battleNotCompatible);
      }
      try {
        const bNetExe = inputs.battleExeOverride || DEFAULT_BATTLE_NET_EXE;
        const bNetDir = path.dirname(bNetExe);
        // Battle.net launches a game only once it has started completely:
        // SRM's launch script restarts it and waits (battle-net-start.ps1),
        // then hands it the game and waits for the game, found by its
        // install folder, to exit.
        const startBattleNet: LaunchScript = {
          script: parserScript("battle-net-start.ps1"),
          args: ["-bnet", bNetExe],
        };
        let finalData: ParsedData = {
          success: [],
          failed: [],
          executableLocation: bNetExe,
        };
        const installed = readBattleNetProducts(BATTLE_NET_PRODUCT_DB);
        for (let product of installed) {
          const productCode: string = product.productCode.toLowerCase();
          if (BNET_GAMES[productCode]) {
            const { launchId, name } = BNET_GAMES[productCode];
            const installPath: string | undefined =
              product.settings?.installPath;
            finalData.success.push({
              extractedTitle: name,
              startInDirectory: bNetDir,
              launchOptions: `--exec="launch ${launchId}"`,
              launchWrapper: {
                preLaunch: [startBattleNet],
                ...(installPath && {
                  game: { folder: path.win32.normalize(installPath) },
                }),
              },
            });
          }
        }
        resolve(finalData);
      } catch (err) {
        reject(this.lang.errors.fatalError__i.interpolate({ error: err }));
      }
    });
  }
}
