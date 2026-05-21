export type ModerationPipelineStageName =
  | 'parse'
  | 'shared-chat-guard'
  | 'admin-bypass'
  | 'rule-engine'
  | 'action-dispatch'
  | 'background-followup';

export type ModerationPipelineContext<TUpdate = unknown> = {
  update: TUpdate;
  webhookEventId?: string | null;
  chatId?: string | null;
  userId?: string | null;
  startedAtMs: number;
};

export type ModerationPipelineStageResult<TContext extends ModerationPipelineContext> =
  TContext | void;

export interface ModerationPipelineStage<
  TContext extends ModerationPipelineContext = ModerationPipelineContext,
> {
  readonly name: ModerationPipelineStageName | string;
  run(context: TContext): Promise<ModerationPipelineStageResult<TContext>>;
}
