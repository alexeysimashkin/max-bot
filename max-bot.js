const axios = require('axios');
const https = require('https');

// ============ НАСТРОЙКИ ============
const MAX_TOKEN = 'f9LHodD0cOIMKBEfixiw3yITxV1aIV8YY72fM-GfqEMOVkXSZR7fIjc5safl3dVst-J5vZOnd45ANfANEkGz';
const API_URL = 'https://ar-smh.ru/api/flights';
const MAX_API = 'https://platform-api2.max.ru';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const maxClient = axios.create({
  baseURL: MAX_API,
  headers: {
    'Authorization': MAX_TOKEN,
    'Content-Type': 'application/json'
  },
  httpsAgent
});

// ============ ХРАНИЛИЩА ============
const userStates = {};
const subscriptions = {};
const lastFlightStates = {};

// ============ УТИЛИТЫ ============
function fmtTm(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDt(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getStatusEmoji(status) {
  if (!status) return '⚪';
  const s = status.toLowerCase();
  if (s.includes('по расписанию')) return '🟢';
  if (s.includes('регистрация') && s.includes('закончена')) return '🟠';
  if (s.includes('регистрация')) return '🔵';
  if (s.includes('посадка') && s.includes('закончена')) return '🟣';
  if (s.includes('посадка')) return '🔴';
  if (s.includes('задержан')) return '🟡';
  if (s.includes('отменён')) return '❌';
  if (s.includes('вылетел')) return '✅';
  if (s.includes('приостановлено')) return '⏸️';
  if (s.includes('питание')) return '🍽️';
  return '⚪';
}

function buildFlightMessage(f) {
  const delayed = f.expectedDeparture && new Date(f.expectedDeparture) > new Date(f.scheduledDeparture);
  const statusEmoji = getStatusEmoji(f.statusText);
  let timeStr;
  if (delayed) timeStr = `${fmtTm(f.scheduledDeparture)} ➡️ ${fmtTm(f.expectedDeparture)}`;
  else timeStr = fmtTm(f.scheduledDeparture);
  const departure = f.expectedDeparture || f.scheduledDeparture;

  return `✈️ Рейс: ${f.flightNumber}, ${f.airline}
📍 В: ${f.destination} (${f.iataCode || ''}), ${timeStr}
🕐 Ожидается в: ${fmtDt(departure)}
🏷️ Данные: Стойки: ${f.checkInCounters || '—'}, Выход: ${f.boardingGate ? 'G' + f.boardingGate : '—'}
${statusEmoji} Статус: ${(f.statusText || 'По расписанию').replace(/\n/g, ' ')}`;
}

function buildNotification(f, statusType) {
  const flight = f.flightNumber || '';
  const city = f.destination || '';
  const iata = f.iataCode || '';
  const counters = f.checkInCounters || '';
  const gate = f.boardingGate || '';

  switch (statusType) {
    case 'checkin':
      return `👋 Уважаемый пассажир!\n\nНачинается регистрация на рейс ${flight} вылетающий в ${city} (${iata}). Стойки регистрации: ${counters}\n\n📄 Не забудьте приготовить документ, удостоверяющий личность!`;
    case 'checkin_completed':
      return `👋 Уважаемый пассажир!\n\nРегистрация на рейс ${flight}, вылетающий в ${city} (${iata}), закончена.\n\n🚶 Посадка на рейс начнётся через несколько минут, выход G${gate}`;
    case 'boarding':
      return `👋 Уважаемый пассажир!\n\nНачинается посадка на рейс ${flight} вылетающий в ${city} (${iata}).\n\n🚪 Приглашаем вас пройти к выходу G${gate}. Приготовьте, пожалуйста, паспорт и посадочный талон. Желаем приятного полёта! ✈️`;
    case 'boarding_completed':
      return `👋 Уважаемый пассажир!\n\nЗакончилась посадка на рейс ${flight} вылетающий в ${city} (${iata}).\n\n🕐 Вылет запланирован на ${fmtDt(f.expectedDeparture || f.scheduledDeparture)}`;
    case 'delayed':
      return `👋 Уважаемый пассажир!\n\n⚠️ Вылет вашего рейса ${flight} в ${city} (${iata}) ${fmtDt(f.scheduledDeparture)} задерживается до ${fmtDt(f.expectedDeparture)}.\n\n😔 Приносим извинения за доставленные неудобства!`;
    case 'cancelled':
      return `👋 Уважаемый пассажир!\n\n❌ Вылет вашего рейса ${flight} в ${city} (${iata}) отменён.\n\n📞 Обращайтесь в авиакомпанию за подробной информацией.`;
    default:
      return null;
  }
}

function findFlights(flights, query, date) {
  const q = query.trim().toLowerCase();
  return flights.filter(f => {
    if (date && f.flightDay !== date) return false;
    const number = (f.flightNumber || '').toLowerCase();
    const dest = (f.destination || '').toLowerCase();
    const iata = (f.iataCode || '').toLowerCase();
    return number.includes(q) || dest.includes(q) || iata === q;
  });
}

function getStatusChangeType(oldStatus, newStatus) {
  if (oldStatus === newStatus) return null;
  if (newStatus === 'cancelled') return 'cancelled';
  if (newStatus === 'delayed') return 'delayed';
  const map = {
    'checkin': 'checkin',
    'checkin_completed': 'checkin_completed',
    'boarding': 'boarding',
    'boarding_completed': 'boarding_completed'
  };
  return map[newStatus] || null;
}

// ============ КЛАВИАТУРЫ ============
function getDateKeyboard() {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          { type: 'callback', text: '📅 Сегодня', payload: JSON.stringify({ cmd: 'date', value: 'today' }) },
          { type: 'callback', text: '📅 Завтра', payload: JSON.stringify({ cmd: 'date', value: 'tomorrow' }) }
        ]
      ]
    }
  };
}

function getBackKeyboard() {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '🔄 Выбрать другую дату', payload: JSON.stringify({ cmd: 'back' }) }]
      ]
    }
  };
}

function getSubscribeKeyboard(flightId, isSubscribed) {
  const buttons = [];
  if (isSubscribed) {
    buttons.push([{ type: 'callback', text: '🔕 Отписаться от рейса', payload: JSON.stringify({ cmd: 'unsub', flightId }) }]);
  } else {
    buttons.push([{ type: 'callback', text: '🔔 Подписаться на рейс', payload: JSON.stringify({ cmd: 'sub', flightId }) }]);
  }
  buttons.push([{ type: 'callback', text: '🔄 Выбрать другую дату', payload: JSON.stringify({ cmd: 'back' }) }]);
  return { type: 'inline_keyboard', payload: { buttons } };
}

// ============ ОТПРАВКА СООБЩЕНИЙ ============
async function sendMessage(userId, text, keyboard = null) {
  try {
    const body = { text, notify: true };
    if (keyboard) body.attachments = [keyboard];
    const r = await maxClient.post(`/messages?user_id=${userId}`, body);
    console.log('✅ MAX отправлено', userId);
    return r.data;
  } catch (e) {
    console.error('❌ MAX ошибка отправки:', e.response?.data || e.message);
    throw e;
  }
}

// ============ ОБРАБОТКА ОБНОВЛЕНИЙ ============
async function handleUpdate(update) {
  console.log('📥 MAX обновление:', JSON.stringify(update).slice(0, 300));

  // Нажатие "Начать"
  if (update.update_type === 'bot_started') {
    const userId = update.user_id || update.chat_id;
    userStates[userId] = { step: 'date' };
    await sendMessage(userId,
      `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`,
      getDateKeyboard());
    return;
  }

  // Нажатие callback-кнопки
  if (update.update_type === 'message_callback') {
    const cb = update.callback;
    if (!cb) return;

    const userId = cb.user?.user_id || update.user_id;
    let payload;
    try { payload = typeof cb.payload === 'string' ? JSON.parse(cb.payload) : cb.payload; } catch (e) { return; }

    // Обязательный ответ на callback
    try {
      await maxClient.post(`/answers?callback_id=${cb.callback_id}`, {
        notification: 'OK'
      });
    } catch (e) {
      console.error('Ошибка answer callback:', e.response?.data || e.message);
    }

    if (payload.cmd === 'date') {
      userStates[userId] = { step: 'search', date: payload.value };
      await sendMessage(userId,
        `🔎 Выбрана дата: ${payload.value === 'today' ? 'Сегодня' : 'Завтра'}\n\nВведите номер рейса, город или код ИАТА (например: SU-1234, Москва, SVO):`,
        getBackKeyboard());
      return;
    }
    if (payload.cmd === 'back') {
      userStates[userId] = { step: 'date' };
      await sendMessage(userId, '📅 Выберите дату:', getDateKeyboard());
      return;
    }
    if (payload.cmd === 'sub') {
      if (!subscriptions[userId]) subscriptions[userId] = {};
      subscriptions[userId][payload.flightId] = true;
      try {
        const r = await axios.get(`${API_URL}?showDeparted=false`);
        const f = r.data.find(x => x.id === payload.flightId);
        if (f) {
          lastFlightStates[payload.flightId] = {
            status: f.computedStatus,
            expected: f.expectedDeparture || null
          };
        }
      } catch (e) {}
      await sendMessage(userId,
        `🔔 Вы подписались на рейс.\n\nЯ буду присылать вам уведомления при:\n• начале регистрации\n• окончании регистрации\n• начале посадки\n• окончании посадки\n• задержке\n• отмене рейса`,
        getSubscribeKeyboard(payload.flightId, true));
      return;
    }
    if (payload.cmd === 'unsub') {
      if (subscriptions[userId]?.[payload.flightId]) {
        delete subscriptions[userId][payload.flightId];
        if (Object.keys(subscriptions[userId]).length === 0) delete subscriptions[userId];
      }
      await sendMessage(userId, `🔕 Вы отписались от уведомлений.`, getSubscribeKeyboard(payload.flightId, false));
      return;
    }
    return;
  }

  // Новое текстовое сообщение
  if (update.update_type === 'message_created') {
    const msg = update.message;
    if (!msg) return;
    const userId = msg.sender?.user_id || update.user_id;
    const text = (msg.body?.text || '').trim();

    const lowerText = text.toLowerCase();
    if (['начать', 'start', '/start', 'привет', 'меню'].includes(lowerText)) {
      userStates[userId] = { step: 'date' };
      await sendMessage(userId,
        `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`,
        getDateKeyboard());
      return;
    }

    const state = userStates[userId];
    if (!state || state.step !== 'search') {
      userStates[userId] = { step: 'date' };
      await sendMessage(userId,
        `👋 Добро пожаловать! Пожалуйста, выберите дату:`,
        getDateKeyboard());
      return;
    }

    try {
      const response = await axios.get(`${API_URL}?showDeparted=false`);
      const flights = response.data;
      const found = findFlights(flights, text, state.date);

      if (found.length === 0) {
        await sendMessage(userId,
          `😔 К сожалению, рейс «${text}» не найден.\n\nПопробуйте ввести другой номер рейса, город или код ИАТА:`,
          getBackKeyboard());
        return;
      }

      const first = found[0];
      const subscribed = subscriptions[userId] && subscriptions[userId][first.id];

      let msg = `🔎 Найдено рейсов: ${found.length}\n\n`;
      msg += found.slice(0, 5).map(buildFlightMessage).join('\n\n➖➖➖➖➖\n\n');

      if (found.length > 5) {
        msg += `\n\n... и ещё ${found.length - 5} рейсов. Уточните запрос.`;
      }

      if (found.length === 1) {
        msg += `\n\n💡 Хотите получать уведомления об изменениях статуса этого рейса? Нажмите кнопку ниже.`;
        await sendMessage(userId, msg, getSubscribeKeyboard(first.id, subscribed));
      } else {
        await sendMessage(userId, msg, getBackKeyboard());
      }
    } catch (e) {
      console.error('Ошибка запроса:', e.message);
      await sendMessage(userId, '⚠️ Произошла ошибка при получении данных. Попробуйте позже.', getBackKeyboard());
    }
  }
}

// ============ ПРОВЕРКА ПОДПИСОК ============
async function checkSubscriptionsAndNotify() {
  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;
    const flightMap = {};
    flights.forEach(f => { flightMap[f.id] = f; });

    for (const userId in subscriptions) {
      for (const flightId in subscriptions[userId]) {
        const flight = flightMap[flightId];
        if (!flight) continue;

        const currentStatus = flight.computedStatus;
        const currentExpected = flight.expectedDeparture || null;
        const old = lastFlightStates[flightId];

        if (!old) {
          lastFlightStates[flightId] = { status: currentStatus, expected: currentExpected };
          continue;
        }

        // ============ ПРОВЕРКА ЗАДЕРЖКИ ПО ВРЕМЕНИ ============
        const sched = new Date(flight.scheduledDeparture);
        const newExp = currentExpected ? new Date(currentExpected) : null;
        const oldExp = old.expected ? new Date(old.expected) : null;

        const wasDelayed = oldExp && oldExp > sched;
        const isDelayed = newExp && newExp > sched;

        if (!wasDelayed && isDelayed) {
          // Только что поставили задержку
          const notification = buildNotification(flight, 'delayed');
          if (notification) {
            try {
              await sendMessage(parseInt(userId), notification);
              console.log(`✅ MAX уведомление о задержке ${userId} (${flightId})`);
            } catch (e) {
              console.error(`❌ Ошибка ${userId}:`, e.message);
            }
          }
        } else if (wasDelayed && isDelayed && newExp.getTime() !== oldExp.getTime()) {
          // Задержка уже была, но время изменилось
          const notification = buildNotification(flight, 'delayed');
          if (notification) {
            try {
              await sendMessage(parseInt(userId), notification);
              console.log(`✅ MAX уведомление о новой задержке ${userId} (${flightId})`);
            } catch (e) {
              console.error(`❌ Ошибка ${userId}:`, e.message);
            }
          }
        } else if (wasDelayed && !isDelayed) {
          // Задержку убрали
          const text = `👋 Уважаемый пассажир!\n\n✈️ Хорошие новости! Ваш рейс ${flight.flightNumber} в ${flight.destination} (${flight.iataCode || ''}) снова вылетает по расписанию — ${fmtDt(flight.scheduledDeparture)}.`;
          try {
            await sendMessage(parseInt(userId), text);
          } catch (e) {}
        }

        // ============ ПРОВЕРКА СМЕНЫ СТАТУСА ============
        if (old.status !== currentStatus) {
          const changeType = getStatusChangeType(old.status, currentStatus);
          if (changeType && changeType !== 'delayed') {
            const notification = buildNotification(flight, changeType);
            if (notification) {
              try {
                await sendMessage(parseInt(userId), notification);
                console.log(`✅ MAX уведомление ${userId} (${changeType})`);
              } catch (e) {
                console.error(`❌ Ошибка ${userId}:`, e.message);
              }
            }
          }
        }

        lastFlightStates[flightId] = { status: currentStatus, expected: currentExpected };
      }
    }
  } catch (e) {
    console.error('MAX проверка подписок:', e.message);
  }
}

// ============ LONG POLLING ============
async function startPolling() {
  console.log('🚀 Запуск Long Polling MAX...');
  let marker = null;

  const poll = async () => {
    try {
      const params = { timeout: 30, limit: 100 };
      if (marker) params.marker = marker;

      const r = await maxClient.get('/updates', { params });
      const data = r.data;

      if (data.marker) marker = data.marker;

      if (data.updates && data.updates.length > 0) {
        for (const update of data.updates) {
          try {
            await handleUpdate(update);
          } catch (e) {
            console.error('Ошибка обработки update:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('Ошибка Long Polling:', e.response?.data || e.message);
      await new Promise(res => setTimeout(res, 3000));
    }
    setTimeout(poll, 100);
  };

  poll();
}

// ============ ЗАПУСК ============
console.log('🚀 MAX-бот аэропорта Симашкино запускается...');

setInterval(checkSubscriptionsAndNotify, 60000);
setTimeout(checkSubscriptionsAndNotify, 30000);

startPolling();

console.log('✅ MAX-бот запущен!');
