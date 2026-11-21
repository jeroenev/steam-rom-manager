import { ImageContent } from "./preview.model";
import { FuzzyEventMap } from "./fuzzy.model";
import { ImageProviderAPI } from "./user-configuration.model";
import { ImageProviderName, OnlineProviderType } from ".";

export interface ProviderInputField {
  [inputKey: string]: {
    label?: string;
    inputType?: "multiselect" | "toggle";
    info?: string;
    multiple?: boolean;
    allowEmpty?: boolean;
    allowedValues?: string[];
  };
}

// A store SteamGridDB knows games by their id at (a platform of its API:
// /games/<platform>/<id>), among those whose games SRM has store ids of.
export type SgdbPlatform = "egs" | "origin" | "bnet";

// A game's id at one of those stores. The artwork providers look the game
// up by it before they search SteamGridDB for its title: an id names the
// game, where a title search finds the closest name.
export interface SgdbPlatformId {
  platform: SgdbPlatform;
  id: string;
}

export type ProviderInfo = Record<
  OnlineProviderType,
  {
    info?: string;
    inputs?: ProviderInputField;
  }
>;

//Callback

export interface ProviderImageData {
  content: ImageContent;
  provider: OnlineProviderType;
}

export interface ProviderErrorData {
  title: string;
  provider: OnlineProviderType;
  error: number | string;
  url?: string;
}

export interface ProviderTimeoutData {
  provider: OnlineProviderType;
  time: number;
}

export interface ProviderCompletedData {
  title: string;
}

export interface ProviderCallbackEventMap {
  image: ProviderImageData;
  error: ProviderErrorData;
  timeout: ProviderTimeoutData;
  completed: ProviderCompletedData;
}

export type ProviderCallback = <K extends keyof ProviderCallbackEventMap>(
  event: K,
  data: ProviderCallbackEventMap[K],
) => void;

//Send

export interface ProviderId {
  id: string;
}

export interface ProviderPostImageData extends ProviderImageData, ProviderId {}

export interface ProviderPostErrorData extends ProviderErrorData, ProviderId {}

export interface ProviderPostTimeoutData
  extends ProviderTimeoutData,
    ProviderId {}

export interface ProviderPostCompletedData
  extends ProviderCompletedData,
    ProviderId {}

export interface ProviderFuzzyEventData {
  event: keyof FuzzyEventMap;
  data: FuzzyEventMap[keyof FuzzyEventMap];
}

export interface ProviderPostEventMap {
  image: ProviderPostImageData;
  error: ProviderPostErrorData;
  timeout: ProviderPostTimeoutData;
  fuzzyEvent: ProviderFuzzyEventData;
  completed: ProviderPostCompletedData;
}

export interface ProviderPostObject<K extends keyof ProviderPostEventMap> {
  event: K;
  data: ProviderPostEventMap[K];
}

//Receive

export interface ProviderFuzzyListData {
  list: { totalGames: number; games: string[] };
}

export interface ProviderRetrieveData extends ProviderId {
  title: string;
  imageType: string;
  imageProviderAPIs: ImageProviderAPI[OnlineProviderType];
}

export interface ProviderFilterData {
  enable: boolean;
}

export interface ProviderReceiveEventMap {
  fuzzyList: ProviderFuzzyListData;
  retrieveUrls: ProviderRetrieveData;
  toggleFiltering: ProviderFilterData;
  stopDownloads: null;
}

export interface ProviderReceiveObject<
  K extends keyof ProviderReceiveEventMap,
> {
  event: K;
  data: ProviderReceiveEventMap[K];
}
