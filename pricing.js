// Single pricing source — loads credits-config.json (canonical).
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'credits-config.json');

function loadPricing() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.warn('pricing: failed to load credits-config.json', e.message);
    return {};
  }
}

function getVoiceTiers() {
  const p = loadPricing();
  return p.voiceTiers || {
    starter: { name: 'Starter', price_annual: 149, voice_per_day: 50, scan_interval: 30, scalp_enabled: false, mirofish_agents: 10 },
    pro: { name: 'Pro', price_annual: 249, voice_per_day: 200, scan_interval: 15, scalp_enabled: true, mirofish_agents: 20 },
    degen: { name: 'Degen', price_annual: 399, voice_per_day: 999999, scan_interval: 5, scalp_enabled: true, mirofish_agents: 30 },
  };
}

function getStripeLinks() {
  return loadPricing().stripeLinks || {};
}

function getAddons() {
  return loadPricing().addons || {};
}

function getCosmeticCoins() {
  return loadPricing().cosmeticCoins || [];
}

/** Public payload for UI + /credits/config */
function publicConfig() {
  const p = loadPricing();
  return {
    tiers: p.tiers,
    actionCosts: p.actionCosts,
    topupPacks: p.topupPacks,
    voiceTiers: p.voiceTiers,
    addons: p.addons,
    stripeLinks: p.stripeLinks,
    cosmeticCoins: p.cosmeticCoins,
    fairUseHardCeiling: p.fairUseHardCeiling,
    defaultChatModel: p.defaultChatModel,
    maxTokensCap: p.maxTokensCap,
    allowedModels: p.allowedModels,
  };
}

module.exports = {
  loadPricing,
  getVoiceTiers,
  getStripeLinks,
  getAddons,
  getCosmeticCoins,
  publicConfig,
  CONFIG_PATH,
};
