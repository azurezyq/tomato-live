import { describe, it, expect } from 'vitest';
import {
  computeSpokenTruncation,
  SentenceChunker,
  stripDuplicatePrefix,
  truncateTextByRatio,
} from '../sentenceChunker';

describe('SentenceChunker (CJK + mixed English)', () => {
  it('splits streaming Chinese sentences on full-width punctuation', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('今天北京天气晴朗')).toEqual([]);
    expect(chunker.push('，气温大约18度。下午微风')).toEqual(['今天北京天气晴朗，气温大约18度。']);
    expect(chunker.push('，很适合出门散步！')).toEqual(['下午微风，很适合出门散步！']);
    expect(chunker.flush()).toEqual([]);
  });

  it('splits long unpunctuated Chinese clauses on comma once threshold is exceeded', () => {
    const chunker = new SentenceChunker({ clauseSplitThreshold: 15, minClauseLength: 8 });
    const out = chunker.push('如果你下午打算去国家博物馆参观的话，建议提前在小程序上预约门票。');
    expect(out).toEqual([
      '如果你下午打算去国家博物馆参观的话，',
      '建议提前在小程序上预约门票。',
    ]);
  });

  it('preserves decimals and English abbreviations in mixed text', () => {
    const chunker = new SentenceChunker();
    const out = chunker.push('圆周率约等于 3.14 左右，Dr. Wang 说很好。Next sentence.');
    expect(out).toEqual(['圆周率约等于 3.14 左右，Dr. Wang 说很好。']);
    expect(chunker.flush()).toEqual(['Next sentence.']);
  });
});

describe('stripDuplicatePrefix', () => {
  it('strips exact echoed opening sentence', () => {
    const s1 = '北京今天天气不错。';
    const cont = '北京今天天气不错。具体来看，最高气温 20 度。';
    expect(stripDuplicatePrefix(s1, cont)).toBe('具体来看，最高气温 20 度。');
  });

  it('strips echoed opening sentence even with half-width/full-width punctuation differences', () => {
    const s1 = '关于这个问题，我帮你查一下！';
    const cont = '关于这个问题, 我帮你查一下! 根据最新公告，活动在周五开始。';
    expect(stripDuplicatePrefix(s1, cont)).toBe('根据最新公告，活动在周五开始。');
  });

  it('leaves non-echoed continuation untouched', () => {
    const s1 = '北京今天天气不错。';
    const cont = '最高气温 20 度，适合户外活动。';
    expect(stripDuplicatePrefix(s1, cont)).toBe(cont);
  });
});

describe('computeSpokenTruncation & truncateTextByRatio', () => {
  it('truncates Chinese text by character ratio and snaps near clause punctuation', () => {
    const text = '今天北京天气晴朗，最高气温二十度，晚上稍微有点凉。';
    const cut = truncateTextByRatio(text, 0.42);
    expect(cut).toBe('今天北京天气晴朗');
  });

  it('truncates English text on word boundaries', () => {
    const text = 'The weather in Beijing is sunny and warm today.';
    const cut = truncateTextByRatio(text, 0.5);
    expect(cut).toBe('The weather in Beijing is');
  });

  it('keeps completed segments, truncates active segment, and drops unplayed segments on barge-in', () => {
    const result = computeSpokenTruncation(
      [
        {
          segmentId: 's1',
          text: '北京今天整体天气不错。',
          stage: 'fast',
          samplesPlayed: 24000,
          totalSamples: 24000,
        },
        {
          segmentId: 's2',
          text: '白天最高气温二十度，下午空气质量优良，适合去公园散步。',
          stage: 'grounded',
          samplesPlayed: 10000,
          totalSamples: 25000, // 40%
        },
        {
          segmentId: 's3',
          text: '另外明天可能会有小雨，记得带伞。',
          stage: 'grounded',
          samplesPlayed: 0,
          totalSamples: 20000,
        },
      ],
      true,
      'zh-CN'
    );

    expect(result.interrupted).toBe(true);
    expect(result.spokenText).toContain('北京今天整体天气不错。');
    expect(result.spokenText).toContain('白天最高气温二十度');
    expect(result.spokenText).toContain('——[用户打断]');
    expect(result.spokenText).not.toContain('明天可能会有小雨');
    expect(result.unspokenText).toContain('明天可能会有小雨');
  });
});
