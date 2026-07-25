export type ConnectionState = "idle" | "connecting" | "connected" | "error";

export interface MassImage {
  path: string;
  provider: string;
  remotely_accessible?: boolean;
  proxy_id?: string;
  url?: string;
}

export interface MediaItem {
  uri: string;
  item_id: string;
  provider: string;
  name: string;
  media_type: string;
  favorite?: boolean;
  image?: MassImage;
  metadata?: { images?: MassImage[] };
  artists?: Array<{ name: string }>;
  album?: MediaItem;
  owner?: string;
}

export interface Player {
  player_id: string;
  display_name?: string;
  name: string;
  available: boolean;
  powered: boolean;
  volume_level: number;
  volume_muted?: boolean;
  state?: string;
  active_source?: string;
  group_childs?: string[];
}

export interface QueueItem {
  queue_item_id: string;
  name: string;
  duration?: number;
  image?: MassImage;
  media_item?: MediaItem;
}

export interface PlayerQueue {
  queue_id: string;
  display_name: string;
  active: boolean;
  available?: boolean;
  shuffle_enabled?: boolean;
  smart_shuffle_active?: boolean;
  repeat_mode?: "off" | "all" | "one";
  is_dynamic?: boolean;
  state: string;
  elapsed_time: number;
  elapsed_time_last_updated: number;
  current_item?: QueueItem;
  next_item?: QueueItem;
  current_index?: number;
  index_in_buffer?: number;
  items?: number;
}

export interface MassEvent {
  event: string;
  object_id?: string;
  data?: unknown;
}

export interface ConnectionConfig {
  serverUrl: string;
  token?: string;
  transport?: "direct" | "bridgething" | "homeassistant";
}

export interface Preset {
  slot: number;
  uri: string;
  name: string;
  mediaType: string;
  image?: MassImage;
}
