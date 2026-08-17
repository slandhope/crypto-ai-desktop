/** Shared Live2D character catalog (main + renderer via <script> or require). */
(function (root) {
  'use strict';

  /**
   * Alexia expression IDs match Alexia.model3.json Names.
   * Moods = automatic reactions. Looks = Dress-Up Shop equip only.
   */
  const ALEXIA_EXPRESSIONS = [
    { id: 'lzx', label: 'Grin', emoji: '😁', kind: 'mood', paramIds: ['Param54'] },
    { id: 'xxy', label: 'Star eyes', emoji: '✨', kind: 'mood', paramIds: ['Param55'] },
    { id: 'lh', label: 'Blush', emoji: '😳', kind: 'mood', paramIds: ['Param58'] },
    { id: 'k', label: 'Cry', emoji: '😢', kind: 'mood', paramIds: ['Param59'] },
    { id: 'sq', label: 'Angry', emoji: '😠', kind: 'mood', paramIds: ['Param57'] },
    { id: 'y', label: 'Dizzy', emoji: '😵', kind: 'mood', paramIds: ['Param56'] },
    { id: 'wh', label: 'Confused', emoji: '❓', kind: 'mood', paramIds: ['Param43'] },
    { id: 'h', label: 'Sweat', emoji: '💦', kind: 'mood', paramIds: ['Param44'] },
    { id: 'mj', label: 'Sunglasses', emoji: '🕶️', kind: 'look', paramIds: ['Param11'] },
    { id: 'dyj', label: 'Glasses', emoji: '👓', kind: 'look', paramIds: ['Param64'] },
    { id: 'yf', label: 'Outfit', emoji: '👗', kind: 'look', paramIds: ['Param16', 'Param17', 'Param61'] },
    { id: 'yfmz', label: 'Outfit + hat', emoji: '🎩', kind: 'look', paramIds: ['Param16', 'Param17', 'Param61'] },
    { id: 'zs1', label: 'Pose', emoji: '💃', kind: 'pose', paramIds: ['Param61', 'Param16', 'Param17'] },
    { id: 'yjys1', label: 'Eye color A', emoji: '👁️', kind: 'look', paramIds: ['Param62'] },
    { id: 'yjys2', label: 'Eye color B', emoji: '🧿', kind: 'look', paramIds: ['Param63'] },
    { id: 'bbt', label: 'BBT', emoji: '🎀', kind: 'look', paramIds: ['Param60'] },
  ];

  /** Shop item id → Live2D expression id (applied when worn). */
  const ALEXIA_SHOP_LIVE2D = {
    alexia_dress: 'yf',
    alexia_hat: 'yfmz',
    glasses: 'dyj',
    sunglasses: 'mj',
    alexia_eyes_a: 'yjys1',
    alexia_eyes_b: 'yjys2',
    alexia_bbt: 'bbt',
  };

  /** Bought pose packs — she does these automatically from time to time. */
  const ALEXIA_SHOP_AUTO_POSES = {
    alexia_pose: 'zs1',
  };

  const ALEXIA_EMOTION_MAP = {
    happy: 'lzx',
    excited: 'xxy',
    love: 'lh',
    sad: 'k',
    angry: 'sq',
    dizzy: 'y',
    thinking: 'wh',
    worried: 'h',
    confused: 'wh',
    sweat: 'h',
    blush: 'lh',
    cry: 'k',
    grin: 'lzx',
    neutral: null,
  };

  const ALEXIA_EXPR_PARAM_IDS = [
    'Param11', 'Param16', 'Param17', 'Param43', 'Param44',
    'Param54', 'Param55', 'Param56', 'Param57', 'Param58', 'Param59',
    'Param60', 'Param61', 'Param62', 'Param63', 'Param64',
  ];

  const CHARACTERS = [
    {
      id: 'asuka',
      name: 'Asuka',
      emoji: '🌸',
      free: true,
      model: './assets/model/huohuo.model3.json',
      scale: 0.07,
      previewScaleDivisor: 8500,
      motionGroup: 'idle',
      expressions: [],
      emotionMap: {},
      expressionParamIds: [],
      shopLive2d: {},
      shopAutoPoses: {},
    },
    {
      id: 'alexia',
      name: 'Alexia',
      emoji: '💜',
      free: true,
      model: './assets/model/alexia/Alexia.model3.json',
      scale: 0.07,
      previewScaleDivisor: 8500,
      offsetY: 28,
      motionGroup: '',
      expressions: ALEXIA_EXPRESSIONS,
      emotionMap: ALEXIA_EMOTION_MAP,
      expressionParamIds: ALEXIA_EXPR_PARAM_IDS,
      shopLive2d: ALEXIA_SHOP_LIVE2D,
      shopAutoPoses: ALEXIA_SHOP_AUTO_POSES,
    },
    { id: 'aria', name: 'Aria', emoji: '🌙', free: false, model: null },
    { id: 'nova', name: 'Nova', emoji: '⚡', free: false, model: null },
    { id: 'ghost', name: 'Ghost', emoji: '👻', free: false, model: null },
    { id: 'lyra', name: 'Lyra', emoji: '🎵', free: false, model: null },
    { id: 'vex', name: 'Vex', emoji: '🔮', free: false, model: null },
    { id: 'kira', name: 'Kira', emoji: '🌺', free: false, model: null },
    { id: 'zero', name: 'Zero', emoji: '🤖', free: false, model: null },
    { id: 'echo', name: 'Echo', emoji: '🌊', free: false, model: null },
  ];

  const DEFAULT_ID = 'asuka';

  function getCharacter(id) {
    const hit = CHARACTERS.find((c) => c.id === id);
    return hit || CHARACTERS.find((c) => c.id === DEFAULT_ID);
  }

  function resolveFromSettings(settings) {
    const s = settings || {};
    if (s.characterId) return getCharacter(s.characterId);
    if (s.characterName) {
      const byName = CHARACTERS.find(
        (c) => c.name.toLowerCase() === String(s.characterName).toLowerCase() && c.model
      );
      if (byName) return byName;
    }
    return getCharacter(DEFAULT_ID);
  }

  function listSelectable() {
    return CHARACTERS.filter((c) => c.free && c.model);
  }

  function characterPayload(ch) {
    if (!ch) ch = getCharacter(DEFAULT_ID);
    return {
      id: ch.id,
      name: ch.name,
      emoji: ch.emoji,
      model: ch.model,
      scale: ch.scale,
      previewScaleDivisor: ch.previewScaleDivisor,
      motionGroup: ch.motionGroup,
      offsetY: ch.offsetY || 0,
      expressions: ch.expressions || [],
      emotionMap: ch.emotionMap || {},
      expressionParamIds: ch.expressionParamIds || [],
      shopLive2d: ch.shopLive2d || {},
      shopAutoPoses: ch.shopAutoPoses || {},
    };
  }

  const api = {
    CHARACTERS,
    DEFAULT_ID,
    ALEXIA_EXPRESSIONS,
    ALEXIA_SHOP_LIVE2D,
    ALEXIA_SHOP_AUTO_POSES,
    getCharacter,
    resolveFromSettings,
    listSelectable,
    characterPayload,
  };
  root.AsukaCharacters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
