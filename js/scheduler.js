// Agendamento por repetição espaçada, no modelo clássico do Anki (SM-2 com etapas de aprendizado).

export const MIN = 60 * 1000;
export const DAY = 24 * 60 * MIN;
const ROLLOVER_HOUR = 4; // o "dia" de estudo vira às 4h, como no Anki
const LEARN_AHEAD = 20 * MIN;

export const DEFAULT_CONFIG = {
  newPerDay: 20,
  revPerDay: 200,
  learnSteps: [1, 10], // minutos
  relearnSteps: [10],
  graduatingIvl: 1, // dias
  easyIvl: 4,
  startEase: 2.5,
  hardFactor: 1.2,
  easyBonus: 1.3,
  lapseMult: 0,
  minIvl: 1,
  maxIvl: 36500,
};

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;

export function dayStart(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  return d.getTime();
}

function addDays(start, days) {
  const d = new Date(start);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function daysBetween(fromDayStart, toDayStart) {
  return Math.round((toDayStart - fromDayStart) / DAY);
}

export function newCardState(pos = 0) {
  return { state: "new", due: 0, ivl: 0, ease: 0, step: 0, reps: 0, lapses: 0, pos };
}

function clampIvl(ivl, cfg) {
  return Math.min(cfg.maxIvl, Math.max(cfg.minIvl, Math.round(ivl)));
}

function fuzz(ivl, random) {
  if (ivl < 3) return ivl;
  const spread = Math.max(1, Math.round(ivl * 0.05));
  return ivl + Math.round((random() * 2 - 1) * spread);
}

// Devolve o cartão como ficaria depois da resposta, sem alterar o original.
export function answer(card, rating, now = Date.now(), cfg = DEFAULT_CONFIG, random = null) {
  const c = { ...card, reps: card.reps + 1 };
  const today = dayStart(now);

  const graduate = (ivl) => {
    if (!c.ease) c.ease = cfg.startEase;
    c.ivl = clampIvl(random ? fuzz(ivl, random) : ivl, cfg);
    c.state = "review";
    c.step = 0;
    c.due = addDays(today, c.ivl);
  };

  if (c.state === "new" || c.state === "learn" || c.state === "relearn") {
    const relearning = c.state === "relearn";
    const configured = relearning ? cfg.relearnSteps : cfg.learnSteps;
    const steps = configured.length ? configured : [1];
    if (c.state === "new") {
      c.state = "learn";
      c.step = 0;
    }
    const step = Math.min(c.step, steps.length - 1);
    if (rating === AGAIN) {
      c.step = 0;
      c.due = now + steps[0] * MIN;
    } else if (rating === HARD) {
      c.step = step;
      let delay = steps[step];
      if (step === 0) delay = steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[0] * 1.5;
      c.due = now + delay * MIN;
    } else if (rating === GOOD) {
      if (step + 1 >= steps.length) graduate(relearning ? c.ivl : cfg.graduatingIvl);
      else {
        c.step = step + 1;
        c.due = now + steps[c.step] * MIN;
      }
    } else {
      graduate(relearning ? c.ivl + 1 : cfg.easyIvl);
    }
    return c;
  }

  // Revisão
  const overdue = Math.max(0, daysBetween(c.due, today));
  const ease = c.ease || cfg.startEase;
  const hardIvl = Math.max(c.ivl + 1, c.ivl * cfg.hardFactor);
  const goodIvl = Math.max(hardIvl + 1, (c.ivl + overdue / 2) * ease);
  const easyIvl = Math.max(goodIvl + 1, (c.ivl + overdue) * ease * cfg.easyBonus);

  if (rating === AGAIN) {
    c.lapses += 1;
    c.ease = Math.max(1.3, ease - 0.2);
    c.ivl = clampIvl(c.ivl * cfg.lapseMult, cfg);
    if (cfg.relearnSteps.length) {
      c.state = "relearn";
      c.step = 0;
      c.due = now + cfg.relearnSteps[0] * MIN;
    } else {
      c.due = addDays(today, c.ivl);
    }
    return c;
  }

  let ivl = goodIvl;
  c.ease = ease;
  if (rating === HARD) {
    ivl = hardIvl;
    c.ease = Math.max(1.3, ease - 0.15);
  } else if (rating === EASY) {
    ivl = easyIvl;
    c.ease = ease + 0.15;
  }
  c.ivl = clampIvl(random ? fuzz(ivl, random) : ivl, cfg);
  c.due = addDays(today, c.ivl);
  return c;
}

// Texto curto do intervalo que cada botão vai aplicar.
export function intervalLabel(card, rating, now = Date.now(), cfg = DEFAULT_CONFIG) {
  const next = answer(card, rating, now, cfg);
  if (next.state !== "review") return formatSpan(next.due - now);
  return formatDays(next.ivl);
}

function formatSpan(ms) {
  const minutes = Math.round(ms / MIN);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return formatDays(Math.round(hours / 24));
}

export function formatDays(days) {
  const n = (v) => String(Math.round(v * 10) / 10).replace(".", ",");
  if (days < 30) return `${days} d`;
  if (days < 365) return `${n(days / 30)} mês`;
  return `${n(days / 365)} a`;
}

export function isSuspended(card) {
  return card.suspended === true;
}

// Classifica um cartão para as contagens do dia.
export function bucket(card, now = Date.now()) {
  if (isSuspended(card)) return null;
  if (card.state === "new") return "new";
  if (card.state === "learn" || card.state === "relearn") {
    return card.due < dayStart(now) + DAY ? "learn" : null;
  }
  return card.due <= dayStart(now) ? "review" : null;
}

// Monta as filas de uma sessão. `done` traz quantos novos e revisões já foram feitos hoje.
export function buildQueues(cards, now, cfg, done = { new: 0, review: 0 }) {
  const learn = [];
  let review = [];
  let fresh = [];
  for (const c of cards) {
    const b = bucket(c, now);
    if (b === "learn") learn.push(c);
    else if (b === "review") review.push(c);
    else if (b === "new") fresh.push(c);
  }
  review.sort((a, b) => a.due - b.due || a.id - b.id);
  review = review.slice(0, Math.max(0, cfg.revPerDay - done.review));
  fresh.sort((a, b) => a.pos - b.pos || a.id - b.id);
  fresh = fresh.slice(0, Math.max(0, cfg.newPerDay - done.new));
  learn.sort((a, b) => a.due - b.due);
  return { learn, review, new: fresh };
}

// Escolhe o próximo cartão: aprendizado vencido primeiro, depois revisões e novos intercalados.
export function nextCard(queues, now = Date.now()) {
  const { learn, review } = queues;
  const fresh = queues.new;
  if (learn.length && learn[0].due <= now) return learn[0];
  if (review.length && fresh.length) {
    const every = Math.max(1, Math.round(review.length / fresh.length));
    queues.sinceNew = (queues.sinceNew || 0) + 1;
    if (queues.sinceNew > every) {
      queues.sinceNew = 0;
      return fresh[0];
    }
    return review[0];
  }
  if (review.length) return review[0];
  if (fresh.length) return fresh[0];
  if (learn.length && learn[0].due <= now + LEARN_AHEAD) return learn[0];
  return null;
}

// Converte o agendamento de um cartão do Anki. `crt` é a criação da coleção, em segundos.
export function fromAnki(row, crt, now = Date.now()) {
  const filtered = row.odid && row.odid !== 0;
  const due = filtered ? row.odue : row.due;
  const base = {
    state: "new",
    due: 0,
    ivl: 0,
    ease: 0,
    step: 0,
    reps: row.reps || 0,
    lapses: row.lapses || 0,
    pos: 0,
  };
  if (row.queue === -1) base.suspended = true;
  if (row.type === 0) return { ...base, pos: due };
  const ease = row.factor ? row.factor / 1000 : DEFAULT_CONFIG.startEase;
  if (row.type === 2 || (row.type === 3 && row.ivl > 0)) {
    const ankiToday = Math.floor((now / 1000 - crt) / 86400);
    const offset = row.type === 2 ? due - ankiToday : 0;
    return { ...base, state: "review", ivl: Math.max(1, row.ivl), ease, due: addDays(dayStart(now), offset) };
  }
  return { ...base, state: "learn", ease: row.factor ? ease : 0, due: now };
}
