export type MessageLimitsBlockedWordPresetId = 'gambling' | 'earnings' | 'crypto';

export type MessageLimitsBlockedWordPreset = {
  id: MessageLimitsBlockedWordPresetId;
  title: string;
  description: string;
  words: readonly string[];
};

export const MESSAGE_LIMITS_BLOCKED_WORD_PRESETS: readonly MessageLimitsBlockedWordPreset[] = [
  {
    id: 'gambling',
    title: 'Казино и ставки',
    description: 'Подходит для отсечения гемблинга, букмекеров, слотов и похожих воронок.',
    words: [
      'казино',
      'ставки',
      'букмекер',
      'слоты',
      'рулетка',
      'джекпот',
      'фрибет',
      'лотерея',
      'тотализатор',
      'беттинг',
    ],
  },
  {
    id: 'earnings',
    title: 'Легкий заработок',
    description:
      'Жесткий набор для спама про доход, подработку, выплаты и обещания без вложений.',
    words: [
      'заработок',
      'подработка',
      'удаленка',
      'выплаты',
      'доход',
      'прибыль',
      'безвложений',
      'процент',
      'проценты',
      'вакансия',
    ],
  },
  {
    id: 'crypto',
    title: 'Крипта и трейдинг',
    description: 'Для крипто-спама, сигналов, арбитража, бирж и трейдинг-объявлений.',
    words: [
      'крипта',
      'криптовалюта',
      'трейдинг',
      'арбитраж',
      'сигналы',
      'биржа',
      'бинанс',
      'фьючерсы',
      'airdrop',
      'p2p',
    ],
  },
] as const;
