export const INCIDENT_EXTERNAL_URL = 'https://ok-short.example/join/incident';
const INCIDENT_EXTERNAL_TEXT = `Проверка ссылки ${INCIDENT_EXTERNAL_URL}`;

export const INCIDENT_EXTERNAL_FORWARD_FIXTURE = {
  body: {
    mid: 'incident-external-forward',
    text: '',
  },
  link: {
    type: 'forward',
    message: {
      text: INCIDENT_EXTERNAL_TEXT,
      markup: [
        {
          type: 'link',
          from: INCIDENT_EXTERNAL_TEXT.indexOf(INCIDENT_EXTERNAL_URL),
          length: INCIDENT_EXTERNAL_URL.length,
          url: INCIDENT_EXTERNAL_URL,
        },
      ],
      attachments: [
        {
          type: 'share',
          payload: { url: INCIDENT_EXTERNAL_URL },
        },
      ],
    },
  },
} as const;

const INCIDENT_MENTION_TEXT = 'Профиль участника';

export const INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE = {
  body: {
    mid: 'incident-profile-forward',
    text: '',
  },
  link: {
    type: 'forward',
    message: {
      text: INCIDENT_MENTION_TEXT,
      markup: [
        {
          type: 'user_mention',
          from: 0,
          length: INCIDENT_MENTION_TEXT.length,
          user_link: 'user/67123224',
        },
      ],
      attachments: [],
    },
  },
} as const;
