import { createPrismaClient } from '../src/prisma/prisma-client';

const prisma = createPrismaClient();

async function main() {
  const profanityWords = [
    { language: 'ru', word: 'бляд', severity: 2, isException: false },
    { language: 'ru', word: 'хуй', severity: 2, isException: false },
    { language: 'ru', word: 'пизд', severity: 2, isException: false },
    { language: 'ru', word: 'еба', severity: 2, isException: false },
    { language: 'ru', word: 'сука', severity: 1, isException: false },
    { language: 'ru', word: 'бляха', severity: 1, isException: true },
  ];

  await prisma.badwordDictionary.createMany({
    data: profanityWords,
    skipDuplicates: true,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
