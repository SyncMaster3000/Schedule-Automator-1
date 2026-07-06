import * as fs from 'fs';
import * as dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO_NAME;

// Получить содержимое файла из GitHub
async function getGitHubFile(filePath: string): Promise<string> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3.raw',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.statusText}`);
  }

  return await response.text();
}

// Отправить код в ChatGPT для анализа
async function analyzeCodeWithChatGPT(code: string, task: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'Ты эксперт по программированию. Анализируй код на русском языке.',
        },
        {
          role: 'user',
          content: `${task}\n\nКод:\n\`\`\`\n${code}\n\`\`\``,
        },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  const data = (await response.json()) as any;

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${data.error?.message}`);
  }

  return data.choices[0].message.content;
}

// Главная функция
async function main() {
  try {
    console.log('📥 Загружаю файл из GitHub...');
    const fileContent = await getGitHubFile('src/main.ts'); // Измените путь на ваш файл

    console.log('🤖 Отправляю на анализ ChatGPT...');
    const analysis = await analyzeCodeWithChatGPT(
      fileContent,
      'Проанализируй этот код и объясни что он делает, какие есть проблемы и как улучшить'
    );

    console.log('\n✅ Результат анализа:\n');
    console.log(analysis);

    // Сохранить результат в файл
    fs.writeFileSync('analysis-result.md', analysis);
    console.log('\n💾 Результат сохранён в analysis-result.md');
  } catch (error) {
    console.error('❌ Ошибка:', error);
    process.exit(1);
  }
}

main();
