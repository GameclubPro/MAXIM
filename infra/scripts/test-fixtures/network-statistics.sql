CREATE TABLE IF NOT EXISTS chats(id text PRIMARY KEY,entity_type text,title text);
CREATE TABLE channel_audience_snapshots(chat_id text,participants_count integer,captured_at timestamp);
CREATE INDEX channel_audience_snapshots_chat_id_captured_at_idx ON channel_audience_snapshots(chat_id,captured_at DESC);
CREATE TABLE channel_stats_sync_states(chat_id text,membership_coverage_from timestamp,views_coverage_from timestamp,
  last_audience_sync_at timestamp,last_views_sync_at timestamp,last_views_discovery_at timestamp);
CREATE UNIQUE INDEX channel_stats_sync_states_chat_id_key ON channel_stats_sync_states(chat_id);
CREATE TABLE channel_posts(id text PRIMARY KEY,chat_id text,published_at timestamp,latest_snapshot_at timestamp,private_body text);
CREATE INDEX channel_posts_chat_id_published_at_idx ON channel_posts(chat_id,published_at DESC);
CREATE TABLE channel_post_view_snapshots(channel_post_id text,captured_at timestamp);
CREATE INDEX channel_post_view_snapshots_channel_post_id_captured_at_idx ON channel_post_view_snapshots(channel_post_id,captured_at DESC);
CREATE TABLE managed_entity_audience_observations(chat_id text,entity_type text,participants_count integer,observed_at timestamptz,source text,PRIMARY KEY(chat_id,entity_type));
CREATE TABLE channel_view_observation_states(channel_post_id text PRIMARY KEY,baseline_at timestamptz,observed_at timestamptz,
  observed_views integer,high_water_views integer,anomaly_at timestamptz,source text);
CREATE TABLE channel_view_observed_intervals(channel_post_id text,chat_id text,from_at timestamptz,to_at timestamptz,delta bigint,quality text,source text,
  PRIMARY KEY(channel_post_id,to_at));
CREATE TABLE channel_view_archive_states(chat_id text PRIMARY KEY,cursor_at timestamptz,discovered_from timestamptz,
  discovery_complete_at timestamptz,last_attempt_at timestamptz,last_success_at timestamptz,full_refresh_at timestamptz,
  stalled_at timestamptz,observed_post_count int,first_observed_at timestamptz,last_observed_at timestamptz);
CREATE TABLE marketplace_bindings(entity_id text,kind text,profile text,state text,statistics_consent bool,collection_owner text,
  collection_metrics jsonb,checked_at timestamptz,valid_until timestamptz,lease_until timestamptz,history_complete bool,
  history_anomaly text,native_history_checked_at timestamptz,native_full_checked_at timestamptz,native_audience_checked_at timestamptz);
CREATE INDEX marketplace_bindings_entity_idx ON marketplace_bindings(entity_id,state);
CREATE TABLE chat_membership_activity_rollups(chat_id text,bucket_start timestamp,joined_users integer,left_users integer,updated_at timestamp,
  PRIMARY KEY(chat_id,bucket_start));
CREATE INDEX chat_membership_activity_rollups_chat_bucket_idx ON chat_membership_activity_rollups(chat_id,bucket_start DESC);
CREATE TABLE chat_membership_activity_feed_items(chat_id text,event_type text,event_at timestamp,source_event_id text,
  canonical_key text PRIMARY KEY,user_id text,bot_id text);
CREATE INDEX chat_membership_activity_feed_items_chat_event_idx ON chat_membership_activity_feed_items(chat_id,event_type,event_at DESC,source_event_id DESC);
CREATE INDEX chat_membership_activity_feed_items_chat_time_idx ON chat_membership_activity_feed_items(chat_id,event_at DESC,source_event_id DESC);
