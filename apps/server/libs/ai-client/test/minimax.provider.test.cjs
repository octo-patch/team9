const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const OpenAI = require('openai');

// Load the actual provider and dispatcher, isolating only Nest/DB wiring.
// OpenAI is deliberately not mocked: assertions inspect its serialized HTTP body.
const framework = {
  Injectable: () => () => {},
  Logger: class {
    log() {}
    warn() {}
    error() {}
  },
  BadRequestException: Error,
};
function loadSource(relativePath, dependencies) {
  const filename = path.join(__dirname, '..', 'src', relativePath);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, module, exports) {${source}\n})`, {
    filename,
  })(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const models = loadSource('interfaces/ai-provider.interface.ts', {});
const { MinimaxProvider } = loadSource('providers/minimax.provider.ts', {
  '@nestjs/common': framework,
  '@team9/database': {},
  openai: OpenAI,
  '../interfaces/ai-provider.interface.js': models,
});
const { AiClientService } = loadSource('ai-client.service.ts', {
  '@nestjs/common': framework,
  './interfaces/ai-provider.interface.js': models,
  './providers/openai.provider.js': {},
  './providers/claude.provider.js': {},
  './providers/gemini.provider.js': {},
  './providers/openrouter.provider.js': {},
  './providers/minimax.provider.js': { MinimaxProvider },
});

test('ordinary MiniMax catalog is Flash first, then M3', () => {
  assert.deepEqual(models.MINIMAX_MODELS, ['MiniMax-M3.1-Flash', 'MiniMax-M3']);
  assert.equal(models.MODELS_BY_PROVIDER.minimax, models.MINIMAX_MODELS);
});

for (const baseURL of [
  undefined,
  'https://api.minimaxi.com/v1',
  'https://proxy.example.test/custom/v1',
]) {
  for (const model of [
    models.MINIMAX_MODELS[0],
    'MiniMax-M3',
    'MiniMax-M2.7',
    'saved-custom-model',
  ]) {
    for (const stream of [false, true]) {
      test(`${baseURL || 'global default'} / ${model} / stream=${stream}`, async (t) => {
        const requests = [];
        t.mock.method(globalThis, 'fetch', async (url, init) => {
          requests.push({
            url: String(url),
            init,
            body: JSON.parse(init.body),
          });
          if (stream) {
            return new Response(
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        });
        const provider = new MinimaxProvider({
          getAIProviderConfig(name) {
            assert.equal(name, 'minimax');
            return { apiKey: 'fixture-only-key', baseURL };
          },
        });
        const otherProvider = {
          chat() {
            throw new Error('Wrong provider');
          },
        };
        const service = new AiClientService(
          otherProvider,
          otherProvider,
          otherProvider,
          otherProvider,
          provider,
        );
        const messages = [
          { role: 'system', content: 'Keep the history.' },
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: 'Earlier answer' },
          { role: 'user', content: 'Continue' },
        ];
        const request = {
          provider: models.AIProvider.MINIMAX,
          model,
          messages,
          stream,
          maxTokens: 123,
          temperature: 0,
        };
        if (stream) {
          let content = '';
          for await (const chunk of service.chat(request)) content += chunk;
          assert.equal(content, 'ok');
        } else {
          const response = await service.chat(request);
          assert.equal(response.model, model);
          assert.equal(response.content, 'ok');
          assert.deepEqual(response.usage, {
            promptTokens: 2,
            completionTokens: 1,
            totalTokens: 3,
          });
        }
        assert.equal(requests.length, 1);
        const sent = requests[0];
        assert.equal(
          sent.url,
          `${baseURL || 'https://api.minimax.io/v1'}/chat/completions`,
        );
        assert.equal(sent.init.method, 'POST');
        assert.equal(
          new Headers(sent.init.headers).get('authorization'),
          'Bearer fixture-only-key',
        );
        assert.deepEqual(sent.body, {
          model,
          messages,
          temperature: 0,
          max_tokens: 123,
          ...(stream ? { stream: true } : {}),
        });
        // No thinking override, unsupported effort/service tier, or split override.
        // The API retains its model-specific defaults; saved IDs and history survive.
        assert.equal(request.model, model);
        assert.deepEqual(request.messages, messages);
      });
    }
  }
}
