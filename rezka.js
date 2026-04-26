/*!
 * HDREZKA plugin for Lampa
 * --------------------------------------------------------
 *  - Online-balanser source (button "HDREZKA" on the card)
 *  - Account login (login + password) via /ajax/login/
 *  - Configurable mirror domain (default: rezka.fi)
 *  - Settings panel: domain / login / password / login button / status
 *
 *  Tested against the public HDREZKA site engine (DLE-based).
 *  Author: generated for the user via Perplexity Computer.
 *  License: MIT
 */
(function () {
    'use strict';

    if (window.rezka_plugin_ready) return;
    window.rezka_plugin_ready = true;

    /* ====================================================
     *  Plugin manifest (shown in Lampa "Extensions" panel)
     * ==================================================== */
    var manifest = {
        type: 'video',
        version: '1.0.41',
        name: 'HDREZKA',
        description: 'Просмотр фильмов и сериалов с HDREZKA по личному аккаунту',
        component: 'rezka_online'
    };

    /* ====================================================
     *  Storage keys / defaults
     * ==================================================== */
    var STORAGE = {
        domain:   'rezka_domain',
        login:    'rezka_login',
        password: 'rezka_password',
        cookie:   'rezka_cookie',     // dle_user_id=...; dle_password=... или [android-session:<ts>]
        status:   'rezka_status',     // 'logged' | 'guest' | 'error:<msg>'
        proxy:    'rezka_proxy_url',  // optional CORS proxy
        quality:  'rezka_quality',    // выбранное качество (глобальный фолбэк)
        loginTs:  'rezka_login_ts'    // timestamp последнего успешного логина — для авто-обновления раз в 3 дня
    };

    // Интервал авто-перелога (3 дня в миллисекундах)
    var RELOGIN_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

    /* v1.0.32: per-film хранилище качества и сезона.
       filmId — это object.movie.id (TMDB id), стабильный per movie. */
    function qualityKeyFor(filmId) {
        return filmId ? ('rezka_quality_' + filmId) : STORAGE.quality;
    }
    function seasonKeyFor(filmId) {
        return filmId ? ('rezka_season_' + filmId) : '';
    }
    function getQualityFor(filmId) {
        try {
            // 1) пробуем per-film, 2) фолбэк на глобальный rezka_quality, 3) 'auto'
            var perFilm = filmId ? Lampa.Storage.get('rezka_quality_' + filmId, '__none__') : '__none__';
            if (perFilm !== '__none__' && perFilm !== null && perFilm !== undefined && perFilm !== '') return perFilm;
            return Lampa.Storage.get(STORAGE.quality, 'auto');
        } catch (e) { return 'auto'; }
    }
    function setQualityFor(filmId, value) {
        try {
            if (filmId) Lampa.Storage.set('rezka_quality_' + filmId, value);
            // Также пишем в глобальный — чтобы это значение было дефолтом для следующих новых фильмов.
            Lampa.Storage.set(STORAGE.quality, value);
        } catch (e) {}
    }
    function getSavedSeason(filmId) {
        try {
            if (!filmId) return '';
            return Lampa.Storage.get('rezka_season_' + filmId, '');
        } catch (e) { return ''; }
    }
    function setSavedSeason(filmId, seasonId) {
        try {
            if (filmId && seasonId) Lampa.Storage.set('rezka_season_' + filmId, String(seasonId));
        } catch (e) {}
    }

    /* Безопасный вызов Lampa.Storage.add — в разных билдах Lampa
       сигнатура разная. Используем get(name, default) — это работает везде.
       Сразу и инициализируем по умолчаниям через set(…, default), если пусто. */
    function ensureDefaults() {
        var defaults = {};
        defaults[STORAGE.domain]   = 'https://rezka.fi';
        defaults[STORAGE.login]    = '';
        defaults[STORAGE.password] = '';
        defaults[STORAGE.cookie]   = '';
        defaults[STORAGE.status]   = 'guest';
        defaults[STORAGE.proxy]    = '';
        defaults[STORAGE.loginTs]  = 0;
        Object.keys(defaults).forEach(function (k) {
            try {
                var cur = Lampa.Storage.get(k, '__none__');
                if (cur === '__none__' || cur === null || cur === undefined) {
                    Lampa.Storage.set(k, defaults[k]);
                }
            } catch (err) {}
        });
    }

    /* ====================================================
     *  Helpers
     * ==================================================== */
    function getDomain() {
        var d = (Lampa.Storage.get(STORAGE.domain) || 'https://rezka.fi').trim();
        if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
        return d.replace(/\/+$/, '');
    }

    function getCookie() {
        return (Lampa.Storage.get(STORAGE.cookie) || '').trim();
    }

    // HTML-escape (в некоторых билдах Lampa нет Lampa.Utils.escape)
    function escapeHTML(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isLoggedIn() {
        // Сессия может жить в OkHttp CookieJar (Android-нативный стек) — тогда
        // getCookie() пуст, но запросы всё равно проходят авторизованно.
        // Поэтому достаточно факта что статус == 'logged'.
        return Lampa.Storage.get(STORAGE.status) === 'logged';
    }

    function buildHeaders(extra) {
        var headers = {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ru,en;q=0.9',
            'Referer': getDomain() + '/',
            'X-Requested-With': 'XMLHttpRequest'
        };
        var ck = getCookie();
        // Не отправляем маркер [android-session:...] в Cookie — это не реальные cookies, а признак что логин
        // был выполнен и cookies лежат в OkHttp jar; native-стек Lampa сам подставит их.
        if (ck && ck.indexOf('[android-session') !== 0) headers['Cookie'] = ck;
        if (extra) for (var k in extra) headers[k] = extra[k];
        return headers;
    }

    /**
     * Pass URL through optional CORS proxy if user configured one.
     * If proxy is empty AND we run in a CORS-restricted browser context,
     * we still try the direct URL — Lampa Android-APK bypasses CORS natively.
     */
    function proxify(url) {
        var p = (Lampa.Storage.get(STORAGE.proxy) || '').trim();
        if (!p) return url;
        // Lampac-style: <proxy>/<url>
        if (p.slice(-1) !== '/') p += '/';
        return p + url;
    }

    function viaProxy(prefix, url) {
        if (prefix.indexOf('?url=') !== -1 || prefix.slice(-1) === '?') {
            return prefix + encodeURIComponent(url);
        }
        return prefix + url;
    }

    /**
     * HDREZKA "trash list" decoder for video URL (#h<base64-with-trash> payload).
     * 1:1 with the canonical algorithm used in nb557/online_mod and HdRezkaApi.
     */
    function decodeTrash(data) {
        if (!data || typeof data !== 'string') return data;
        if (data.charAt(0) !== '#') return data;

        // Сервер вставляет base64-версии этих строк, предварённых //_//
        var trashList = ['$$!!@$$@^!@#$$@', '@@@@@!##!^^^', '####^!!##!@@', '^^^!@##!!##', '$$#!!@#!@##'];

        // Аналог браузерного btoa() для UTF-8 строк
        function enc(str) {
            return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
                function (m, p1) { return String.fromCharCode(parseInt(p1, 16)); }));
        }
        function dec(str) {
            return decodeURIComponent(atob(str).split('').map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
        }
        function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

        var x = data.substring(2); // убираем ведущие два символа (обычно "#h")
        trashList.forEach(function (t) {
            var token = '//_//' + enc(t);
            // все вхождения, а не только первое
            x = x.split(token).join('');
        });
        try { return dec(x); } catch (e) {
            try { return atob(x); } catch (e2) { return ''; }
        }
    }

    /**
     * Parse the HDREZKA playlist string returned by /ajax/get_cdn_series/.
     * Format (after decode): [1080p Ultra]https://x/1080.mp4 or https://x/1080.mp4,[720p]...
     */
    function parsePlaylist(str) {
        if (!str) return [];
        var result = [];
        var parts = str.split(',');
        parts.forEach(function (part) {
            var m = part.match(/\[([^\]]+)\](.+)/);
            if (!m) return;
            var label = m[1].trim();
            var urls = m[2].split(' or ');
            // last URL is usually the highest-quality / mp4 fallback
            var file = urls[urls.length - 1].trim();
            result.push({ label: label, file: file });
        });
        return result;
    }

    /**
     * Network helper – wraps Lampa.Reguest.
     *
     * Важно: HDREZKA блокирует CORS-запросы из браузера. В Android-Lampa
     * есть специальный метод network["native"], который использует нативный
     * HTTP-стек (OkHttp) — он обходит CORS и поддерживает ручные cookies
     * через заголовок Cookie. Для веб-клиентов и iOS/Tizen — падаем обратнона silent.
     */
    function request(opts, success, error) {
        var network = new Lampa.Reguest();
        network.timeout(15000);

        var headers = buildHeaders(opts.headers);
        // С native-стеком запрещённые браузерные заголовки не используются, но при silent
        // браузер выкидывает ReferenceError на Referer/Cookie. Чистим их для silent fallback.
        var safeHeaders = {};
        for (var k in headers) {
            var lk = k.toLowerCase();
            if (lk === 'cookie' || lk === 'referer' || lk === 'user-agent' || lk === 'host') continue;
            safeHeaders[k] = headers[k];
        }

        var params = {
            dataType: opts.dataType || 'text',
            headers: headers,
            withCredentials: true
        };

        // v1.0.38: гарантированно вызовём success/error ровно один раз —
        // даже если silent зависнет (нет ни ответа, ни ошибки).
        var settled = false;
        var settleSuccess = function (data) {
            if (settled) return; settled = true;
            try { success(data); } catch (e) { console.log('REZKA', 'success cb threw', e && e.message); }
        };
        var settleError = function (a, b) {
            if (settled) return; settled = true;
            try { error(a, b); } catch (e) { console.log('REZKA', 'error cb threw', e && e.message); }
        };
        // hard-таймаут 20 сек: если ничего не пришло — error «timeout»
        var hardTimer = setTimeout(function () {
            if (!settled) {
                console.log('REZKA', 'request HARD-TIMEOUT for', opts.url);
                settleError({ status: 0 }, 'timeout');
            }
        }, 20000);
        var origSuccess = function (data) {
            clearTimeout(hardTimer);
            settleSuccess(data);
        };
        var origError = function (a, b) {
            clearTimeout(hardTimer);
            settleError(a, b);
        };

        function callSilent(reason) {
            console.log('REZKA', 'silent attempt' + (reason ? ' (' + reason + ')' : ''), 'url=', opts.url);
            network.silent(opts.url, function (data) {
                var len = (typeof data === 'string') ? data.length : -1;
                console.log('REZKA', 'silent OK len=', len);
                origSuccess(data);
            }, function (a, b) {
                console.log('REZKA', 'silent FAIL status=', (a && a.status) || a, 'msg=', b);
                origError(a, b);
            }, opts.post || false,
                { dataType: opts.dataType || 'text', headers: safeHeaders });
        }

        // 1) Предпочтительно — native (Android APK)
        try {
            if (typeof network["native"] === 'function' &&
                Lampa.Platform && Lampa.Platform.is && Lampa.Platform.is('android')) {
                console.log('REZKA', 'native attempt url=', opts.url, 'cookie len=', (headers.Cookie || '').length, 'method=', opts.post ? 'POST' : 'GET');
                network["native"](opts.url, function (data) {
                    var len = (typeof data === 'string') ? data.length : -1;
                    console.log('REZKA', 'native OK len=', len, 'url=', opts.url);
                    origSuccess(data);
                }, function (a, b) {
                    // fallback на silent в случае ошибки native-стека
                    var statusCode = (a && a.status) || 0;
                    console.log('REZKA', 'native fail status=', statusCode, 'msg=', b, 'cookie len=', (headers.Cookie || '').length, 'url=', opts.url);
                    // v1.0.40: 404 на HTML-странице (не search) — это сервер rezka.fi отверг сессию:
                    //   • cookie len = 0     → cookie не выставлен
                    //   • cookie len > 0     → cookie выставлен, но сервер его не принял
                    //     (протёк, IP-binding, битый, и т.д.)
                    // В обоих случаях silent fallback бесполезен (в браузере Lampa-Web сработает
                    // CORS-блок) — сразу сообщаем юзеру.
                    if (statusCode === 404 && opts.url.indexOf('search.php') === -1) {
                        var ck = headers.Cookie || '';
                        var diag = ck.length === 0
                            ? 'сессия пуста. Введите cookie в настройках'
                            : 'сервер отклонил cookie (' + ck.length + ' байт). Возьмите свежие на rezka.fi с этого же устройства';
                        console.log('REZKA', 'native 404 on HTML —', diag);
                        try { Lampa.Noty && Lampa.Noty.show && Lampa.Noty.show('HDREZKA: ' + diag); } catch (e2) {}
                        origError({ status: 401 }, 'login required: ' + diag);
                        return;
                    }
                    callSilent('native-fail-' + statusCode);
                }, opts.post || false, params);
                return network;
            }
        } catch (e) {
            console.log('REZKA', 'native threw, fallback to silent:', e && e.message);
        }

        // 2) silent для веб/iOS/Tizen — без запрещённых заголовков
        callSilent('no-native');
        return network;
    }

    /* ====================================================
     *  Auth: login to HDREZKA
     *  Ключевые правки в v1.0.3:
     *  — network["native"] (обходит CORS в Android-Lampa) вместо .silent
     *  — Без запрещённых браузером заголовков (Referer/User-Agent)
     *  — withCredentials: true чтобы cookie от ajax/login попадали в document.cookie
     *  — Защита от повторных кликов
     * ==================================================== */
    var _authInProgress = false;

    function authenticate(login, password, cb) {
        if (_authInProgress) {
            console.log('REZKA', 'login already in progress, ignoring duplicate click');
            return;
        }
        _authInProgress = true;
        var done = function (ok, msg) { _authInProgress = false; cb(ok, msg); };

        var post = 'login_name=' + encodeURIComponent(login) +
                   '&login_password=' + encodeURIComponent(password) +
                   '&login_not_save=0';

        var userProxy = (Lampa.Storage.get(STORAGE.proxy) || '').trim();
        // Попытки: 1) прямой, 2) пользовательский прокси (если есть)
        var attempts = [''];
        if (userProxy) {
            attempts.push(userProxy.slice(-1) === '/' ? userProxy : userProxy + '/');
        }

        function tryNext(idx) {
            if (idx >= attempts.length) {
                Lampa.Storage.set(STORAGE.status, 'error:network');
                return done(false, 'Сетевая ошибка. Используйте вход по Cookie (введите вручную)');
            }
            var prefix = attempts[idx];
            var fullUrl = getDomain() + '/ajax/login/?t=' + Date.now();
            var url = prefix ? viaProxy(prefix, fullUrl) : fullUrl;

            console.log('REZKA', 'login attempt #' + idx + ' via', prefix || 'direct', 'url=', url);

            var net = new Lampa.Reguest();
            net.timeout(15000);

            // network["native"] = нативный сетевой стек Android (обходит CORS),
            // или fallback на .silent в браузере.
            var fn = (typeof net['native'] === 'function') ? net['native'] : net.silent;
            fn.call(net, url, function (response) {
                console.log('REZKA', 'login response:', JSON.stringify(response).slice(0, 200));
                handleResponse(response);
            }, function (xhr, status) {
                console.log('REZKA', 'login error via', prefix || 'direct', '→ status', status);
                tryNext(idx + 1);
            }, post, {
                dataType: 'json',
                withCredentials: true,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
        }

        function handleResponse(response) {
            var ok = false, msg = '';
            try {
                var json;
                if (typeof response === 'object' && response !== null) {
                    json = response;
                } else {
                    json = JSON.parse(String(response));
                }
                ok = !!json.success;
                msg = json.message || json.log || '';
            } catch (e) {
                msg = 'Некорректный ответ сервера: ' + (typeof response).slice(0, 30);
            }

            if (ok) {
                // 1) Пробуем достать cookies из document.cookie (веб-версия Lampa).
                //    На Android этого не будет — dle_* идут с флагом HttpOnly,
                //    они ложатся в OkHttp CookieJar и невидимы для JS.
                var cookieStr = '';
                try { cookieStr = document.cookie || ''; } catch (e) {}
                var dle = cookieStr.split(';').map(function (s) { return s.trim(); })
                    .filter(function (s) { return /^dle_(user_id|password|hash|forum_sessions)=/.test(s); })
                    .join('; ');
                console.log('REZKA', 'login OK; document.cookie dle=', dle ? 'YES (' + dle.length + ' bytes)' : 'NO (HttpOnly/Android)');

                // 2) Verification: дёрнем главную без явного Cookie-хедера.
                //    На Android это проверит работает ли jar; на вебе — отправятся document.cookie.
                // ВАЖНО: не пишем Storage.cookie ДО verify — иначе старый (протухший) cookie
                // попадёт в хедеры verifySession и перебьёт jar.
                Lampa.Storage.set(STORAGE.cookie, ''); // очистили старое на время проверки
                verifySession(function (verified, hint) {
                    if (verified) {
                        console.log('REZKA', 'session verified via', hint);
                        // В cookie пишем либо реальные dle, либо маркер что логин в jar.
                        var saved = dle || '[android-session:' + Date.now() + ']';
                        Lampa.Storage.set(STORAGE.cookie, saved);
                        Lampa.Storage.set(STORAGE.status, 'logged');
                        Lampa.Storage.set(STORAGE.loginTs, Date.now());
                        done(true, 'Вход успешен (' + hint + '). ' +
                            (dle ? 'cookies сохранены: ' + dle.length + ' байт' : 'cookies в OkHttp jar (Android)'));
                    } else {
                        console.log('REZKA', 'session verify FAILED:', hint);
                        if (dle) {
                            // Есть реальные cookies в браузере — сохраняем их.
                            Lampa.Storage.set(STORAGE.cookie, dle);
                            Lampa.Storage.set(STORAGE.status, 'logged');
                            Lampa.Storage.set(STORAGE.loginTs, Date.now());
                            done(true, 'Вход OK. cookies: ' + dle.length + ' байт (verify: ' + hint + ')');
                        } else {
                            // Логин-ответ был ОК, но сессия не подтверждена.
                            Lampa.Storage.set(STORAGE.status, 'error:verify failed');
                            done(false, 'Вход ОК по ответу сервера, но сессия не пробросилась (' + hint + '). Используйте ручной ввод cookie');
                        }
                    }
                });
            } else {
                Lampa.Storage.set(STORAGE.status, 'error:' + (msg || 'login failed'));
                done(false, msg || 'Не удалось войти (проверьте логин/пароль)');
            }
        }

        // Verifies session by hitting the homepage and looking for an authenticated
        // marker. If document.cookie has dle_user_id we're already done.
        // Otherwise we hope that Android OkHttp's CookieJar carries cookies forward.
        function verifySession(cb) {
            // shortcut: если Storage.cookie — реальные dle_* (не маркер), считаем верифицированным
            var ck = getCookie();
            if (ck && ck.indexOf('[android-session') !== 0 && /dle_user_id=/.test(ck)) return cb(true, 'document.cookie');

            var net = new Lampa.Reguest();
            net.timeout(10000);
            var url = getDomain() + '/?t=' + Date.now();
            var fn = (typeof net['native'] === 'function' &&
                      Lampa.Platform && Lampa.Platform.is && Lampa.Platform.is('android'))
                     ? net['native'] : net.silent;
            fn.call(net, url, function (html) {
                var s = String(html || '').slice(0, 30000);
                // Признаки залогиненного пользователя:
                //   <a href="/users/..." — ссылка на профиль
                //   data-uid="\d+" — идентификатор юзера
                //   <div class="b-user-section" — личный блок
                //   /logout/ — кнопка выхода
                var loggedHints = /href="\/(?:logout|user)\/|class="b-user-section|data-uid="\d+"|<a[^>]+class="b-topnav__layer-controls__logout"|name="action"\s+value="logout"/i;
                var loginHints = /<title>\s*Вход\s*<\/title>|id="login_name"|action="\/ajax\/login\/"/i;
                if (loggedHints.test(s)) cb(true, 'OkHttp jar');
                else if (loginHints.test(s)) cb(false, 'server returned login page');
                else cb(false, 'no auth markers (' + s.length + ' bytes)');
            }, function (xhr, st) {
                cb(false, 'verify network error: ' + st);
            }, false, {
                dataType: 'text',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'ru,en;q=0.9'
                }
            });
        }

        tryNext(0);
    }

    /**
     * Ручной вход по cookie-строке.
     * Пользователь вставляет 'dle_user_id=...; dle_password=...' из браузера.
     */
    function applyManualCookie(cookieStr, cb) {
        if (!cookieStr || !/dle_user_id=/.test(cookieStr) || !/dle_password=/.test(cookieStr)) {
            return cb(false, 'Строка должна содержать dle_user_id=... и dle_password=...');
        }
        // Нормализуем
        var dle = cookieStr.split(';').map(function (s) { return s.trim(); })
            .filter(function (s) { return /^dle_(user_id|password|hash|forum_sessions)=/.test(s); })
            .join('; ');
        Lampa.Storage.set(STORAGE.cookie, dle);
        Lampa.Storage.set(STORAGE.status, 'logged');
        Lampa.Storage.set(STORAGE.loginTs, Date.now());

        // Сразу проверим что сессия действительно работает
        var net = new Lampa.Reguest();
        net.timeout(10000);
        var url = getDomain() + '/?t=' + Date.now();
        var fn = (typeof net['native'] === 'function' &&
                  Lampa.Platform && Lampa.Platform.is && Lampa.Platform.is('android'))
                 ? net['native'] : net.silent;
        fn.call(net, url, function (html) {
            var s = String(html || '').slice(0, 30000);
            var loggedHints = /href="\/(?:logout|user)\/|class="b-user-section|data-uid="\d+"|name="action"\s+value="logout"/i;
            var loginHints = /<title>\s*Вход\s*<\/title>|id="login_name"|action="\/ajax\/login\/"/i;
            if (loggedHints.test(s)) cb(true, '🟢 Сессия активна — HDREZKA готова');
            else if (loginHints.test(s)) cb(false, 'Cookie сохранён, но сервер всё ещё показывает вход. Проверьте dle_user_id/dle_password или возьмите свежие из браузера.');
            else cb(true, 'Сессия сохранена (статус: ' + s.length + ' байт)');
        }, function () {
            cb(true, 'Сессия сохранена (без проверки — сетевая ошибка)');
        }, false, {
            dataType: 'text',
            headers: buildHeaders()
        });
    }

    function logout() {
        Lampa.Storage.set(STORAGE.cookie, '');
        Lampa.Storage.set(STORAGE.status, 'guest');
        Lampa.Storage.set(STORAGE.loginTs, 0);
    }

    /* ====================================================
     *  Search on HDREZKA
     *  GET /engine/ajax/search.php?q=<title>
     * ==================================================== */
    // searchRezka(query, year, cb, opts)
    //   year: если задан — фильтрует items по совпадающему году (если есть совпадения)
    //   year='all' или false/0 — никакого фильтра, возвращает все результаты
    //   opts.strict: если true и year задан — возвращает ТОЛЬКО items с точно совпадающим годом
    //                (даже если результат пустой). Без этого флага при 0 точных совпадениях
    //                возвращались все items, что приводило к открытию неверного фильма.
    function searchRezka(query, year, cb, opts) {
        opts = opts || {};
        var url = proxify(getDomain() + '/engine/ajax/search.php?q=' + encodeURIComponent(query));
        console.log('REZKA', 'search start: query=', query, 'year=', year, 'strict=', !!opts.strict, 'url=', url);
        request({ url: url }, function (html) {
            var preview = (typeof html === 'string' ? html : JSON.stringify(html)).slice(0, 200);
            console.log('REZKA', 'search response len=', (typeof html === 'string' ? html.length : -1), 'preview=', preview);
            // <li><a href="..."><span class="enty">Title</span> (Original, 2023)<span class="rating">8.50</span></a></li>
            var div = document.createElement('div');
            div.innerHTML = html;
            var items = [];
            div.querySelectorAll('a').forEach(function (a) {
                var href = a.getAttribute('href');
                if (!href || href.indexOf('search') !== -1) return;
                // Основное название — из .enty (русский вариант)
                var entyEl = a.querySelector('.enty');
                var title = entyEl ? (entyEl.textContent || '').trim() : '';
                // Полный текст (содержит и оригинал, и год, и рейтинг)
                var fullText = (a.textContent || '').trim();
                if (!title) {
                    // без .enty — берём всю строку до «(слово, год)»
                    title = fullText.replace(/\s*\([^)]*\d{4}\)[\s\S]*$/, '').trim();
                }
                // Извлекаем хвост в скобках: "(Оригинал, 2023)" или "(2023)"
                var tailMatch = fullText.match(/\(([^)]*\d{4}[^)]*)\)/);
                var details = tailMatch ? tailMatch[1].trim() : '';
                // Год — из любого вхождения (4 цифры 19xx/20xx)
                var ym = fullText.match(/\b(19|20)\d{2}\b/);
                items.push({
                    url: href,
                    title: title,
                    year: ym ? ym[0] : '',
                    details: details // «Оригинал, 2023» или «Русский, США, 2026»
                });
            });
            // если знаем год и не 'all' — предпочитаем точное совпадение
            if (year && year !== 'all') {
                var exact = items.filter(function (i) { return i.year == String(year); });
                if (exact.length) {
                    items = exact;
                } else if (opts.strict) {
                    // strict-year: при отсутствии точного совпадения — пустой результат,
                    // чтобы вызывающий код мог попробовать fallback (например, поиск по original_title)
                    console.log('REZKA', 'search strict-year: no exact-year items, returning empty');
                    items = [];
                }
            }
            console.log('REZKA', 'search parsed items=', items.length, items.length ? 'first=' + JSON.stringify(items[0]) : '');
            cb(items);
        }, function (a, b) {
            console.log('REZKA', 'search ERROR status=', (a && a.status) || a, 'msg=', b);
            cb([]);
        });
    }

    /* ====================================================
     *  Parse film page → translators / seasons / film_id
     * ==================================================== */
    function fetchFilmPage(filmUrl, cb, err) {
        console.log('REZKA', 'fetchFilmPage url=', filmUrl);
        request({ url: proxify(filmUrl), dataType: 'text' }, function (str) {
            var slen = (str || '').length;
            console.log('REZKA', 'fetchFilmPage response len=', slen);
            // v1.0.38: пустой/обрезанный ответ — выводим явную ошибку, а не «Здесь пусто»
            if (slen < 1000) {
                console.log('REZKA', 'fetchFilmPage ⚠️ пустой/короткий ответ (' + slen + ' байт). preview=', (typeof str === 'string' ? str.slice(0, 200) : str));
                if (err) err({ status: 0 }, 'сервер вернул пустой ответ (' + slen + ' байт)');
                return;
            }
            // Диагностика: сервер отдаёт страницу входа — значит сессия не применилась
            if (typeof str === 'string' && /<title>\s*Вход\s*<\/title>/i.test(str)) {
                console.log('REZKA', 'fetchFilmPage ⚠️ Сервер вернул страницу ЛОГИНА. cookie len=', getCookie().length, 'status=', Lampa.Storage.get(STORAGE.status));
                Lampa.Noty && Lampa.Noty.show && Lampa.Noty.show('HDREZKA: сессия не применилась. Введите cookie вручную в настройках.');
                if (err) err({status: 401}, 'login required');
                return;
            }
            var info = {
                film_id: '',
                is_series: false,
                favs: '',
                voice: [],   // [{name, id, is_camrip, is_ads, is_director}]
                season: [],  // [{name, id}]
                episode: [], // [{name, season_id, episode_id}]
                page_url: filmUrl
            };

            // film id. Сигнатура rezka:
            //   initCDNMoviesEvents(film_id, translator_id, is_camrip[0|1], is_ads[0|1], is_director[0|1])
            //   initCDNSeriesEvents(film_id, translator_id, def_season, def_episode, false, 'host', ...)
            // Сериальный вариант НЕ ограничен [0|1] на 3-й/4-й позиции —
            // там лежат номера сезона/серии. Берём любые числа.
            var idm = str.match(/initCDN(?:Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+|true|false))?)?/);
            if (idm) {
                info.film_id = idm[1];
                var defVoiceId = idm[2];
                info.is_series = /initCDNSeriesEvents/.test(str);
                // Для фильмов: idm[3..5] = camrip/ads/director (всегда 0 или 1).
                // Для сериалов: idm[3..4] = def_season/def_episode — camrip/ads не используются.
                var isOneOrZero = function (v) { return v === '0' || v === '1'; };
                var camrip = (info.is_series ? '0' : (idm[3] || '0'));
                var ads = (info.is_series ? '0' : (idm[4] || '0'));
                var director = (info.is_series ? '0' : (idm[5] && isOneOrZero(idm[5]) ? idm[5] : '0'));

                // favs hash
                var fm = str.match(/var\s+sof\s*=.*?\.send\([^,]+,\s*'([^']+)'/);
                if (!fm) fm = str.match(/data-favs="([^"]+)"/);
                if (fm) info.favs = fm[1];

                // Диагностика: логируем сырой HTML блока переводов — видно будет в консоли Lampa
                try {
                    var dbgM = str.match(/<h2>В переводе<\/h2>:[\s\S]{0,3000}?<\/td>/);
                    if (dbgM) console.log('REZKA', 'translators block (В переводе):', dbgM[0].slice(0, 2500));
                    var dbgU = str.match(/<ul[^>]+(?:translators-list|b-translators?__list)[\s\S]{0,4000}?<\/ul>/);
                    if (dbgU) console.log('REZKA', 'translators block (ul):', dbgU[0].slice(0, 2500));
                    if (!dbgM && !dbgU) console.log('REZKA', 'translators block: НЕ НАЙДЕН');
                } catch (e) {}

                // translators block
                // Исправлено: принимаем ОБА варианта класса:
                //   - b-translator__list  (одиночный translator) — сериалы
                //   - b-translators__list (translatorS) — фильмы на rezka.ag/.fi
                // Также ищем по id="translators-list" как fallback.
                var tm = str.match(/<ul[^>]+class="b-translators?__list"[\s\S]*?<\/ul>/);
                if (!tm) tm = str.match(/<ul[^>]+id="translators-list"[\s\S]*?<\/ul>/);
                if (tm) {
                    var d = document.createElement('div');
                    d.innerHTML = tm[0];
                    d.querySelectorAll('.b-translator__item').forEach(function (li) {
                        // Имя с флагом языка (если есть <img title="Украинский">) —
                        // иначе "Дубляж" и "Дубляж (Укр)" неотличимы в плейлисте.
                        var baseName = (li.getAttribute('title') || li.textContent || '').trim();
                        var langs = [];
                        li.querySelectorAll('img').forEach(function (img) {
                            var l = (img.getAttribute('title') || img.getAttribute('alt') || '').trim();
                            if (l && baseName.indexOf(l) === -1) langs.push(l);
                        });
                        var name = langs.length ? (baseName + ' (' + langs.join(', ') + ')') : baseName;
                        info.voice.push({
                            name: name,
                            id: li.getAttribute('data-translator_id') || defVoiceId,
                            is_camrip:   li.getAttribute('data-camrip')   || camrip,
                            is_ads:      li.getAttribute('data-ads')      || ads,
                            is_director: li.getAttribute('data-director') || director
                        });
                    });
                }
                // На части страниц (НАПРИМЕР rezka.fi) блока b-translator__list нет —
                // вместо этого переводы лежат в <td>: <a ...>Дубляж</a>, <a ...>RS</a>, ...
                // Каждая ссылка имеет атрибут data-translator_id (или onclick="...translator_id...").
                if (!info.voice.length) {
                    var dn = str.match(/<h2>В переводе<\/h2>:[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/);
                    if (dn) {
                        var dd = document.createElement('div'); dd.innerHTML = dn[1];
                        // 1) пробуем выдернуть ссылки
                        var anchors = dd.querySelectorAll('a');
                        if (anchors.length) {
                            anchors.forEach(function (a) {
                                var name = (a.getAttribute('title') || a.textContent || '').trim();
                                if (!name) return;
                                // id может быть в data-translator_id, data-id, или в onclick="...,XXX,..."
                                var id = a.getAttribute('data-translator_id') || a.getAttribute('data-id') || '';
                                if (!id) {
                                    // rezka.fi: onclick="initCDNMoviesEvents(<film_id>, <translator_id>, ...)"
                                    // нужен именно второй числовой аргумент — первый это ID фильма,
                                    // и если взять его для всех озвучек, все получат одинаковый поток.
                                    var oc = a.getAttribute('onclick') || a.getAttribute('data-onclick') || '';
                                    // Возможные вызовы: initCDNMoviesEvents(film_id, tid, ...) или
                                    // sof.tv.reloadMovieTranslation(this, tid, ...) — во втором случае tid идёт первым числом.
                                    var im = oc.match(/initCDN[A-Za-z]+Events\(\s*\d+\s*,\s*(\d+)/);
                                    if (im) id = im[1];
                                    if (!id) {
                                        var im2 = oc.match(/reload(?:Movie|Series)Translation\([^,]*,\s*(\d+)/);
                                        if (im2) id = im2[1];
                                    }
                                    // fallback — второе числовое вхождение (id фильма + id перевода)
                                    if (!id) {
                                        var nums = oc.match(/\d{2,}/g);
                                        if (nums && nums.length >= 2) id = nums[1];
                                        else if (nums && nums.length) id = nums[0];
                                    }
                                }
                                info.voice.push({
                                    name: name,
                                    id: id || defVoiceId,
                                    is_camrip: camrip, is_ads: ads, is_director: director
                                });
                            });
                        }
                        // 2) fallback — только текст в виде "Дубляж, RS, НТВ, Украинский дубляж ..."
                        // В этом случае из страницы НЕТ реальных translator_id — rezka даёт только один
                        // вызов initCDN(...) с дефолтным id. Показывать все имена как отдельные озвучки — обман:
                        // все будут играть ode и тот же поток (id же один). Поэтому делаем ОДНУ озвучку
                        // с дефолтным id, а в имени укажем все доступные (без «Оригинал» и субтитры).
                        if (!info.voice.length) {
                            var raw = (dd.textContent || '').trim().replace(/\s*\(\+субтитры\)\s*$/i, '');
                            // Выбираем «лучшее» имя для отображения: Первое имя из списка (обычно Дубляж)
                            var firstName = raw.split(/[,и] /)[0].trim() || 'Стандартная';
                            console.log('REZKA', 'voice fallback (no per-translator id on page) — single voice with id=' + defVoiceId, ', дефолтное имя:', firstName);
                            info.voice.push({
                                name: firstName,
                                id: defVoiceId,
                                is_camrip: camrip, is_ads: ads, is_director: director
                            });
                        }
                    }
                }
                if (!info.voice.length) {
                    info.voice.push({
                        name: 'Оригинал',
                        id: defVoiceId,
                        is_camrip: camrip, is_ads: ads, is_director: director
                    });
                }
                console.log('REZKA', 'parsed voices:', info.voice.length, info.voice.map(function(v){return v.name+'#'+v.id;}).join(' | '));

                if (info.is_series) {
                    // ВНИМАНИЕ: класс на rezka выглядит как 'b-simple_seasons__list clearfix',
                    // поэтому нельзя матчить class="b-simple_seasons__list" с закрывающей кавычкой.
                    // Используем нежадный поиск по началу класса или по id=simple-seasons-tabs.
                    var sm = str.match(/<ul[^>]+(?:id="simple-seasons-tabs"|class="[^"]*b-simple_seasons__list[^"]*")[\s\S]*?<\/ul>/);
                    if (sm) {
                        var ds = document.createElement('div'); ds.innerHTML = sm[0];
                        ds.querySelectorAll('.b-simple_season__item').forEach(function (li) {
                            info.season.push({
                                name: (li.textContent || '').trim(),
                                id: li.getAttribute('data-tab_id')
                            });
                        });
                        console.log('REZKA', 'parsed seasons:', info.season.length, info.season.map(function(s){return s.name+'#'+s.id;}).join(' | '));
                    } else {
                        console.log('REZKA', 'WARN seasons block not found in HTML (b-simple_seasons__list / id=simple-seasons-tabs)');
                    }
                    // У эпизодов тоже class="b-simple_episodes__list clearfix". Берём ВСЕ <ul>
                    // у которых id="simple-episodes-list-N" или класс начинается с b-simple_episodes__list.
                    var em = str.match(/<ul[^>]+(?:id="simple-episodes-list-\d+"|class="[^"]*b-simple_episodes__list[^"]*")[\s\S]*?<\/ul>/g);
                    if (em) {
                        em.forEach(function (block) {
                            var de = document.createElement('div'); de.innerHTML = block;
                            de.querySelectorAll('.b-simple_episode__item').forEach(function (li) {
                                info.episode.push({
                                    name: (li.textContent || '').trim(),
                                    season_id: li.getAttribute('data-season_id'),
                                    episode_id: li.getAttribute('data-episode_id')
                                });
                            });
                        });
                        console.log('REZKA', 'parsed episodes:', info.episode.length, 'across', em.length, 'season block(s)');
                    } else {
                        console.log('REZKA', 'WARN episodes blocks not found in HTML (b-simple_episodes__list)');
                    }
                    // Если на странице нет ни сезонов, ни эпизодов (старый макет / ленивая
                    // загрузка) — попробуем дозагрузить через ajax/get_cdn_series action=get_episodes.
                    // Реализуется отдельно по необходимости. Для основной массы новых страниц
                    // (rezka.fi 2025+) seasons и episodes лежат в HTML напрямую.
                    if (!info.season.length || !info.episode.length) {
                        console.log('REZKA', 'series HTML has no inline seasons/episodes — will rely on ajax fallback if needed');
                    }
                }
                cb(info);
            } else {
                err && err('Не удалось распарсить страницу');
            }
        }, function () { err && err('Сетевая ошибка'); });
    }

    /* ====================================================
     *  Get direct stream url
     *  POST /ajax/get_cdn_series/  (action=get_movie | get_stream)
     * ==================================================== */
    function getStream(info, voice, season, episode, cb, err) {
        var url = proxify(getDomain() + '/ajax/get_cdn_series/?t=' + Date.now());
        // ГАРДЫ: пустой translator_id или film_id → rezka отвечает "Время сессии истекло".
        // Лучше сразу выдать ясный ответ чем ввести в заблуждение.
        if (!info || !info.film_id) {
            console.log('REZKA', 'getStream ABORT: empty film_id', info);
            err && err('Не удалось определить ID фильма на rezka');
            return;
        }
        if (!voice || !voice.id || String(voice.id).trim() === '' || String(voice.id) === '0') {
            console.log('REZKA', 'getStream ABORT: empty translator_id, voice=', JSON.stringify(voice));
            err && err('Не удалось определить вариант озвучки (translator_id)');
            return;
        }
        var post;
        if (info.is_series && season && episode) {
            // Для сериала НЕ передаём is_camrip/is_ads/is_director — эти поля только для фильмов.
            post = 'id=' + encodeURIComponent(info.film_id) +
                   '&translator_id=' + encodeURIComponent(voice.id) +
                   '&season=' + encodeURIComponent(season.id) +
                   '&episode=' + encodeURIComponent(episode.episode_id) +
                   '&favs=' + encodeURIComponent(info.favs || '') +
                   '&action=get_stream';
        } else {
            post = 'id=' + encodeURIComponent(info.film_id) +
                   '&translator_id=' + encodeURIComponent(voice.id) +
                   '&is_camrip=' + encodeURIComponent(voice.is_camrip || 0) +
                   '&is_ads=' + encodeURIComponent(voice.is_ads || 0) +
                   '&is_director=' + encodeURIComponent(voice.is_director || 0) +
                   '&favs=' + encodeURIComponent(info.favs || '') +
                   '&action=get_movie';
        }
        console.log('REZKA', 'getStream POST voice=', voice && voice.name, 'tid=', voice && voice.id, 'film_id=', info.film_id, 's=', season && season.id, 'e=', episode && episode.episode_id);
        console.log('REZKA', 'getStream POST body=', post);
        console.log('REZKA', 'getStream POST url=', url);

        // Используем общий request() helper — он умеет network.native (Android, обходит CORS,
        // подставляет ручные cookies). XMLHttpRequest напрямую не работает: CORS блокирует
        // запрос, withCredentials не подставит наш сохранённый dle_user_id.
        request({
            url: url,
            post: post,
            dataType: 'text',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
            }
        }, function (resp) {
            try {
                var json = typeof resp === 'string' ? JSON.parse(resp) : resp;
                if (!json || !json.success) {
                    var srvMsg = (json && json.message) || 'Сервер вернул ошибку';
                    // rezka отвечает "Время сессии истекло" не только при невалидных cookie,
                    // но и при невалидных полях (пустой translator_id, нечисловые season/episode).
                    // Поэтому показываем как исходный message, так и параметры запроса.
                    var diag = '';
                    if (/истек|сесси|expired/i.test(srvMsg)) {
                        diag = ' [tid=' + (voice && voice.id) + ' fid=' + (info && info.film_id) +
                               ' s=' + (season && season.id) + ' e=' + (episode && episode.episode_id) + ']';
                    }
                    console.log('REZKA', 'getStream server fail. srvMsg=', srvMsg, '| raw=', resp && String(resp).slice(0, 500), '| sentBody=', post);
                    err && err(srvMsg + diag);
                    return;
                }
                var decoded = decodeTrash(json.url);
                var items = parsePlaylist(decoded);
                if (!items.length) { err && err('Пустой плейлист'); return; }
                var qualities = {};
                var qPrefForSort = getQualityFor(window._rezkaCurrentFilmId);
                // Сортируем от лучшего к худшему для корректного Player.getUrlQuality fallback.
                // При равном parseInt (напр. 1080p и 1080p Ultra) — ставим выбранное пользователем вариант ПЕРВЫМ,
                // чтобы Lampa.Player.getUrlQuality (`for(var q in quality)`) выбрал именно его.
                var sortedItems = items.slice().sort(function (a, b) {
                    var ha = parseInt(a.label, 10) || 0;
                    var hb = parseInt(b.label, 10) || 0;
                    if (ha !== hb) return hb - ha;
                    // равные по высоте: предпочтённый ярлык — раньше
                    if (qPrefForSort && qPrefForSort !== 'auto') {
                        if (a.label === qPrefForSort) return -1;
                        if (b.label === qPrefForSort) return 1;
                    }
                    // иначе: Ultra раньше обычного (более качественный битрейт по умолчанию)
                    var ua = /ultra/i.test(a.label) ? 1 : 0;
                    var ub = /ultra/i.test(b.label) ? 1 : 0;
                    return ub - ua;
                });
                // Lampa.Player выбирает уровень через parseInt(ключ) == Storage.video_quality_default.
                // На rezka бывают ключи '4K' (parseInt=4) и '2K' (parseInt=2) — они никогда не
                // совпадут с 1080/2160. Нормализуем имя: '4K' → '2160p', '2K' → '1440p'.
                // '1080p Ultra' оставляем как есть — переключение между 1080p и 1080p Ultra в
                // фильтре плагина не работает (оба parseInt=1080), но в меню плеера они видны
                // как разные пункты и пользователь может выбрать нужный.
                function normalizeQualityLabel(label) {
                    var s = String(label || '').trim();
                    if (/^4K\b/i.test(s)) return s.replace(/^4K\b/i, '2160p');
                    if (/^2K\b/i.test(s)) return s.replace(/^2K\b/i, '1440p');
                    return s;
                }
                sortedItems.forEach(function (it) { qualities[normalizeQualityLabel(it.label)] = it.file; });
                // Сохраняем фактические лейблы этого фильма для перестроения sort-меню в buildFilter()
                try {
                    var labels = sortedItems.map(function (it) { return normalizeQualityLabel(it.label); });
                    Lampa.Storage.set('rezka_quality_available', labels.join(','));
                } catch (e) {}
                // Плейлист от hdrezka.fi отдаёт качества от худшего (360p) к лучшему (4K) в items[],
                // выбираем файл по пользовательскому предпочтению (Storage rezka_quality).
                // fallback: берём ближайшее по высоте качество — или лучшее (последний элемент items).
                var qPref = getQualityFor(window._rezkaCurrentFilmId);
                var picked = items[items.length - 1]; // по умолчанию — лучшее
                if (qPref && qPref !== 'auto') {
                    var prefHeight = parseInt(qPref, 10) || 0;
                    // 1) точное совпадение нормализованного лейбла
                    var exact = null;
                    for (var i = 0; i < items.length; i++) {
                        if (normalizeQualityLabel(items[i].label) === qPref) { exact = items[i]; break; }
                    }
                    if (exact) picked = exact;
                    else if (prefHeight) {
                        // 2) ближайшее не выше желаемого (лучшее из доступных ≤ prefHeight)
                        var best = null, bestH = 0;
                        for (var j = 0; j < items.length; j++) {
                            var h = parseInt(normalizeQualityLabel(items[j].label), 10) || 0;
                            if (h <= prefHeight && h > bestH) { best = items[j]; bestH = h; }
                        }
                        if (best) picked = best;
                    }
                }
                console.log('REZKA', 'getStream picked', picked && picked.label, 'pref=', qPref, 'available=', Object.keys(qualities).join('/'), 'voice=', voice && voice.name, 'tid=', voice && voice.id, 'urlHash=', (picked.file || '').slice(-40));
                // Сообщаем в компонент (если подписан) — он перестроит sort-меню
                try { Lampa.Listener.send('rezka_quality', { type: 'available', labels: sortedItems.map(function(i){return i.label;}) }); } catch(e) {}
                cb({
                    title: '',
                    file: picked.file,
                    quality: qualities,
                    chosenQuality: picked.label,
                    subtitles: parseSubtitles(json.subtitle)
                });
            } catch (e) {
                console.log('REZKA', 'getStream parse error', e && e.message, resp);
                err && err('Не удалось разобрать ответ');
            }
        }, function (xhr, msg) {
            console.log('REZKA', 'getStream network error', msg, xhr && xhr.status);
            err && err('Сетевая ошибка' + (msg ? ': ' + msg : ''));
        });
    }

    function parseSubtitles(s) {
        if (!s || typeof s !== 'string') return [];
        // format: "[lang]url,[lang2]url2,..."
        return s.split(',').map(function (part) {
            var m = part.match(/\[([^\]]+)\](.+)/);
            return m ? { label: m[1], url: m[2] } : null;
        }).filter(Boolean);
    }

    /* ====================================================
     *  TMDB episode names cache
     *  rezka всегда отдаёт эпизоды как "Серия N" — реальные имена
     *  доступны только через TMDB. Lampa уже передаёт TMDB id в object.movie.id.
     * ==================================================== */
    var _tmdbEpCache = {}; // key: tmdbId+':'+season -> { ep_number: name }

    function fetchTMDBEpisodes(tmdbId, seasonNum, cb) {
        if (!tmdbId || !seasonNum) { cb({}); return; }
        var key = tmdbId + ':' + seasonNum;
        if (_tmdbEpCache[key]) { cb(_tmdbEpCache[key]); return; }
        try {
            if (!Lampa.TMDB || typeof Lampa.TMDB.api !== 'function') {
                console.log('REZKA', 'TMDB api unavailable, skipping episode names');
                cb({}); return;
            }
            var lang = '';
            try { lang = Lampa.Storage.get('tmdb_lang') || Lampa.Storage.get('language') || 'ru'; } catch(e) { lang = 'ru'; }
            // ВАЖНО: TMDB.api() добавляет только email=, но НЕ api_key. Без api_key — 401.
            var apiKey = '';
            try { apiKey = (Lampa.TMDB && typeof Lampa.TMDB.key === 'function') ? Lampa.TMDB.key() : ''; } catch(e) {}
            var keyParam = apiKey ? ('api_key=' + encodeURIComponent(apiKey) + '&') : '';
            var apiUrl = Lampa.TMDB.api('tv/' + tmdbId + '/season/' + seasonNum + '?' + keyParam + 'language=' + encodeURIComponent(lang));
            var net = new Lampa.Reguest();
            net.timeout(8000);
            net.silent(apiUrl, function (json) {
                // map: { episode_number: { name, still } } — для отображения имени и персонального постера серии.
                var map = {};
                if (json && json.episodes && json.episodes.length) {
                    json.episodes.forEach(function (e) {
                        if (e && e.episode_number) {
                            map[e.episode_number] = {
                                name: e.name || '',
                                still: e.still_path ? ('https://image.tmdb.org/t/p/w300' + e.still_path) : ''
                            };
                        }
                    });
                }
                _tmdbEpCache[key] = map;
                console.log('REZKA', 'TMDB episodes fetched: tmdb=' + tmdbId + ' s=' + seasonNum + ' → ' + Object.keys(map).length + ' names');
                cb(map);
            }, function (xhr, msg) {
                console.log('REZKA', 'TMDB episodes fetch fail', msg, xhr && xhr.status);
                _tmdbEpCache[key] = {};
                cb({});
            });
        } catch (e) {
            console.log('REZKA', 'TMDB call exception', e && e.message);
            cb({});
        }
    }

    /* ====================================================
     *  Lampa Online component
     * ==================================================== */
    function component(object) {
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);
        var html = $('<div></div>');

        var state = {
            info: null,
            choice: { voice: 0, season: 0 }
        };

        this.create = function () {
            console.log('REZKA', 'component.create called');

            scroll.body().addClass('torrent-list');
            files.appendFiles(scroll.render());
            files.appendHead(filter.render());
            // вычитаем высоту шапки (фильтра) из висимой области scroll — иначе список не скроллится
            try { scroll.minus(files.render().find('.explorer__files-head')); }
            catch (e) { try { scroll.minus(); } catch (e2) {} }

            filter.onSearch = function (value) {
                Lampa.Activity.replace({ search: value, clarification: true });
            };
            filter.onBack = function () { self.start(); };
            try { if (filter.addButtonBack) filter.addButtonBack(); } catch (e) {}

            // Lampa НЕ вызывает initialize() автоматически — вызываем сами
            try { this.initialize(); } catch (err) {
                console.log('REZKA', 'initialize() crashed:', err && err.message, err);
            }

            return this.render();
        };

        this.render = function () { return files.render(); };

        var self = this;

        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;
            try {
                if (Lampa.Utils && typeof Lampa.Utils.cardImgBackgroundBlur === 'function') {
                    Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
                } else if (object.movie && (object.movie.background_image || object.movie.img)) {
                    Lampa.Background.immediately(object.movie.background_image || object.movie.img);
                }
            } catch (e) { /* ignore background errors */ }
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(), files.render());
                    Lampa.Controller.collectionFocus(false, scroll.render());
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () { Navigator.move('down'); },
                left: function () { Lampa.Controller.toggle('menu'); },
                right: function () {
                    // Раньше просто двигался вправо по карточкам.
                    // Ниже: если вправо двигаться некуда — перекидываем фокус на фильтр вверху.
                    if (Navigator.canmove('right')) { Navigator.move('right'); return; }
                    try { Lampa.Controller.toggle('head'); } catch (e) {}
                },
                back: this.back
            });
            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.back = function () { Lampa.Activity.backward(); };
        this.destroy = function () {
            network.clear();
            scroll.destroy();
            files.destroy();
            filter.destroy();
            html.remove();
        };

        // search & render flow ---------------------------------
        function showError(msg) {
            var empty = new Lampa.Empty({ text: msg });
            html.append(empty.render());
            scroll.append(html);
        }

        // Применяем выбор качества к данным, которые идут в Lampa.Player. Lampa внутри play()
        // переписывает data.url = getUrlQuality(data.quality) — выбирая ключ где
        // parseInt(ключ) == Storage.field('video_quality_default') (строка '480'/'720'/'1080'/'1440'/'2160').
        // Ставим этот storage временно перед play(), потом восстанавливаем.
        // Применяем выбор качества к данным, которые идут в Lampa.Player. Глобальный listener (вне компонента)
        // регистрируется при запуске плагина — см. registerGlobalQualityListener() ниже.
        function applyQualityToPlayer() {
            // v1.0.32: берём per-film, фолбэк на глобальный
            var qPref = getQualityFor(curFilmId());
            // Поднимаем флаг «это мы сами пишем», чтобы global listener игнорировал это событие.
            window._rezkaSelfWritingVQD = true;
            try {
                if (qPref && qPref !== 'auto') {
                    var n = parseInt(qPref, 10) || 0;
                    if (n) {
                        try { Lampa.Storage.set('video_quality_default', String(n)); } catch (e) {}
                        console.log('REZKA', 'applyQualityToPlayer set video_quality_default=', String(n), 'pref=', qPref);
                    }
                } else {
                    // «Максимальное» — попробуем 4096, и Lampa поищет лучший фолбэк через set_better
                    try { Lampa.Storage.set('video_quality_default', '4096'); } catch (e) {}
                    console.log('REZKA', 'applyQualityToPlayer set video_quality_default=4096 (auto)');
                }
            } finally {
                // Снимаем флаг синхронно — listener вызывается внутри Storage.set() синхронно.
                window._rezkaSelfWritingVQD = false;
            }
        }

        // ====================================================================
        // playFilm: для фильма запускает выбранную озвучку и прикрепляет
        // voiceovers → кнопка «Дорожки» в плеере покажет список озвучек (единый UX с сериалами).
        // Плейлист не создаём — в фильме он лишний (одно и то же видео с разными озвучками).
        // ====================================================================
        function playFilm(info, defIdx) {
            if (!info.voice || !info.voice.length) {
                Lampa.Noty.show('HDREZKA: нет озвучек');
                return;
            }
            // v1.0.32: запоминаем filmId — global quality listener будет писать per-film.
            try { window._rezkaCurrentFilmId = curFilmId(); } catch (e) {}
            defIdx = (typeof defIdx === 'number' && defIdx >= 0) ? defIdx : 0;
            if (defIdx >= info.voice.length) defIdx = 0;
            var movieTitle = (object.movie.title || object.movie.name || '');
            var origTitle = (object.movie.original_title || object.movie.original_name || movieTitle || '');
            var hash = strHash(origTitle);
            var sharedTimeline = null;
            try { if (Lampa.Timeline) sharedTimeline = Lampa.Timeline.view(hash); } catch (e) {}

            var curVoice = info.voice[defIdx];

            Lampa.Modal.open({
                title: 'HDREZKA',
                html: $('<div style="padding:1em">Получаем ссылку (' + escapeHTML(curVoice.name) + ')…</div>'),
                size: 'small',
                onBack: function () { Lampa.Modal.close(); Lampa.Controller.toggle('content'); }
            });

            getStream(info, curVoice, null, null,
                function (firstData) {
                    Lampa.Modal.close();
                    applyQualityToPlayer();
                    var item = {
                        title: movieTitle + ' — ' + curVoice.name,
                        url: firstData.file,
                        quality: firstData.quality,
                        subtitles: firstData.subtitles,
                        voice_name: curVoice.name
                    };
                    if (sharedTimeline) item.timeline = sharedTimeline;

                    // Дорожки озвучки → кнопка «Дорожки» в плеере.
                    if (info.voice.length > 1) {
                        try {
                            var voiceovers = info.voice.map(function (v, vi) {
                                return {
                                    label: v.name,
                                    title: v.name,
                                    language: v.name,
                                    index: vi,
                                    selected: vi === defIdx,
                                    enabled:  vi === defIdx,
                                    onSelect: function () {
                                        if (vi === defIdx) return;
                                        console.log('REZKA', 'film voice change in player:', curVoice.name, '->', v.name);
                                        Lampa.Noty.show('HDREZKA: переключаю на «' + v.name + '»…');
                                        try { Lampa.Player.close(); } catch (e) {}
                                        // Обновляем выбор в state, чтобы фильтр в карточном UI отражал актуальное.
                                        try { state.choice.voice = vi; } catch (e) {}
                                        setTimeout(function () { playFilm(info, vi); }, 200);
                                    }
                                };
                            });
                            item.voiceovers = voiceovers;
                        } catch (e) { console.log('REZKA', 'film voiceovers attach error', e && e.message); }
                    }

                    Lampa.Player.play(item);
                    // Без Lampa.Player.playlist() — плейлист фильму не нужен.
                },
                function (msg) {
                    Lampa.Modal.close();
                    Lampa.Noty.show('HDREZKA: ' + msg);
                });
        }

        // ====================================================================
        // playSeries: для сериала строит playlist всех серий выбранного сезона
        // в выбранной озвучке. Каждая серия имеет индивидуальный timeline
        // (прогресс сохраняется отдельно для каждой серии).
        // epIdx — индекс серии, с которой начнётся воспроизведение.
        // ====================================================================
        function playSeries(info, voice, season, items, epIdx) {
            if (!items || !items.length) { Lampa.Noty.show('HDREZKA: нет серий'); return; }
            // v1.0.32: запоминаем filmId — для global quality listener.
            try { window._rezkaCurrentFilmId = curFilmId(); } catch (e) {}
            epIdx = (typeof epIdx === 'number' && epIdx >= 0 && epIdx < items.length) ? epIdx : 0;
            var movieTitle = (object.movie.title || object.movie.name || '');
            var origTitle = (object.movie.original_name || object.movie.original_title || movieTitle || '');

            function epHash(ep) {
                var sNum = parseInt(ep.season_id || season.id, 10) || 0;
                var eNum = parseInt(ep.episode_id || ep.name, 10) || 0;
                return strHash([sNum, sNum > 10 ? ':' : '', eNum, origTitle].join(''));
            }

            var firstEp = items[epIdx];
            Lampa.Modal.open({
                title: 'HDREZKA',
                html: $('<div style="padding:1em">Получаем ссылку (' + escapeHTML(voice.name) + ' · ' + escapeHTML(firstEp.name) + ')…</div>'),
                size: 'small',
                onBack: function () { Lampa.Modal.close(); Lampa.Controller.toggle('content'); }
            });

            getStream(info, voice, season, firstEp,
                function (firstData) {
                    Lampa.Modal.close();
                    applyQualityToPlayer();
                    var playlist = items.map(function (ep, i) {
                        var sNum = parseInt(ep.season_id || season.id, 10) || 0;
                        var eNum = parseInt(ep.episode_id || ep.name, 10) || 0;
                        // Предпочитаем имя эпизода из TMDB (ep.tmdb_name), иначе — "Серия N"
                        var epLabel = ep.tmdb_name || ep.name || ('Серия ' + (i + 1));
                        var cell = {
                            title: movieTitle + ' — ' + epLabel,
                            season: sNum,
                            episode: eNum,
                            voice_name: voice.name,
                            _ep_idx: i // запоминаем индекс для смены озвучки
                        };
                        try { if (Lampa.Timeline) cell.timeline = Lampa.Timeline.view(epHash(ep)); } catch (e) {}
                        if (i === epIdx) {
                            cell.url = firstData.file;
                            cell.quality = firstData.quality;
                            cell.subtitles = firstData.subtitles;
                        } else {
                            cell.url = function (call) {
                                getStream(info, voice, season, ep,
                                    function (data) {
                                        cell.url = data.file;
                                        cell.quality = data.quality;
                                        cell.subtitles = data.subtitles;
                                        call();
                                    },
                                    function () {
                                        cell.url = '';
                                        Lampa.Noty.show('HDREZKA: не удалось получить ссылку');
                                        call();
                                    });
                            };
                        }
                        return cell;
                    });
                    var first = playlist[epIdx];
                    first.playlist = playlist;

                    // Сериал: добавляем «voiceovers» — в плеере это кнопка «Дорожки» с выбором озвучки.
                    // При выборе — закрываем плеер и перезапускаем на той же серии с новой озвучкой.
                    if (info.voice && info.voice.length > 1) {
                        try {
                            var voiceovers = info.voice.map(function (v, vi) {
                                return {
                                    label: v.name,
                                    title: v.name,
                                    language: v.name,
                                    index: vi,
                                    selected: vi === info.voice.indexOf(voice),
                                    enabled:  vi === info.voice.indexOf(voice),
                                    onSelect: function (a) {
                                        if (vi === info.voice.indexOf(voice)) return; // тот же выбор
                                        // Из плеера берём текущую серию и сезон
                                        var pdata = {};
                                        try { pdata = Lampa.Player.playdata() || {}; } catch (e) {}
                                        var curEpIdx = (typeof pdata._ep_idx === 'number') ? pdata._ep_idx : epIdx;
                                        console.log('REZKA', 'voice change in player:', voice.name, '->', v.name, 'epIdx=', curEpIdx);
                                        Lampa.Noty.show('HDREZKA: переключаю на «' + v.name + '»…');
                                        try { Lampa.Player.close(); } catch (e) {}
                                        // Обновляем voice + серии для этой озвучки (может потребоваться get_episodes для другого переводчика)
                                        try { state.choice.voice = vi; } catch (e) {}
                                        var _replay = function () {
                                        if (typeof reloadEpisodesForVoice === 'function') {
                                            reloadEpisodesForVoice(v, season.id, function () {
                                                try {
                                                    var ni = state.info;
                                                    var newSeason = ni.season[state.choice.season] || season;
                                                    var newItems  = (ni.episode || []).filter(function (e) { return String(e.season_id) === String(newSeason.id); });
                                                    if (!newItems.length) newItems = items;
                                                    var newEpIdx  = Math.min(curEpIdx, newItems.length - 1);
                                                    if (newEpIdx < 0) newEpIdx = 0;
                                                    playSeries(ni, v, newSeason, newItems, newEpIdx);
                                                } catch (e) { console.log('REZKA', 'voice-change replay error', e && e.message); Lampa.Noty.show('HDREZKA: не удалось переключить озвучку'); }
                                            });
                                        } else {
                                            playSeries(info, v, season, items, curEpIdx);
                                        }
                                        };
                                        setTimeout(_replay, 200);
                                    }
                                };
                            });
                            first.voiceovers = voiceovers;
                        } catch (e) { console.log('REZKA', 'voiceovers attach error', e && e.message); }
                    }

                    Lampa.Player.play(first);
                    Lampa.Player.playlist(playlist);
                },
                function (msg) {
                    Lampa.Modal.close();
                    Lampa.Noty.show('HDREZKA: ' + msg);
                });
        }

        // Нужен ИМЕННО тот же хэш, что использует Lampa карточка/другие плагины — иначе
        // прогресс не будет находиться в file_view. Используем Lampa.Utils.hash если доступен,
        // иначе — идентичная реализация (Math.abs(djb2-style hash) в десятичной форме).
        function strHash(str) {
            try {
                if (Lampa.Utils && typeof Lampa.Utils.hash === 'function') {
                    return Lampa.Utils.hash(String(str || ''));
                }
            } catch (e) { /* fallback */ }
            var h = 0, s = String(str || '');
            if (s.length === 0) return '' + h;
            for (var i = 0; i < s.length; i++) {
                h = ((h << 5) - h) + s.charCodeAt(i);
                h = h & h;
            }
            return '' + Math.abs(h);
        }

        // Создаёт prestige-карточку в стиле lampac (постер + таймлайн + детали просмотра + инфо + качество)
        function makePrestigeCard(opts) {
            // opts: {title, time, info[] (может быть HTML в элементах), quality, hash, poster, tagline}
            var infoParts = [];
            if (opts.tagline) infoParts.push('<span class="tagline">«' + escapeHTML(opts.tagline) + '»</span>');
            (opts.info || []).filter(Boolean).forEach(function (i) {
                infoParts.push('<span>' + escapeHTML(i) + '</span>');
            });
            var infoLine = infoParts.join('<span class="rezka-prestige-split">●</span>');
            var card = $(Lampa.Template.get('rezka_prestige_full', {
                title:   escapeHTML(opts.title || ''),
                time:    escapeHTML(opts.time  || ''),
                info:    infoLine,
                quality: escapeHTML(opts.quality || '')
            }));
            // постер
            var imgWrap = card.find('.rezka-prestige__img');
            var img = imgWrap.find('img');
            if (opts.poster) {
                img.on('load', function () { imgWrap.addClass('rezka-prestige__img--loaded'); });
                img.on('error', function () { img.attr('src', ''); imgWrap.css('background', '#333'); });
                img.attr('src', opts.poster);
            }
            // Timeline view + render прогресс-бара + Lampa.Timeline.details для текста
            // «Просмотрено — 1ч 10м из 1ч 28м / 79%». Оба элемента обновляются Lampa
            // автоматически по data-hash при любом Timeline.update().
            try {
                if (opts.hash && Lampa.Timeline) {
                    var view = Lampa.Timeline.view(opts.hash);
                    card.data('timeline', view);
                    card.find('.rezka-prestige__timeline').append(Lampa.Timeline.render(view));
                    if (Lampa.Timeline.details) {
                        var det = Lampa.Timeline.details(view);
                        card.find('.rezka-prestige__details')
                            .toggleClass('hide', !view.percent)
                            .append(det);
                    }
                }
            } catch (e) { /* timeline optional */ }
            return card;
        }

        function getPoster() {
            var m = object.movie || {};
            var p = m.background_image || m.img;
            if (p) return p;
            if (m.poster_path) return 'https://image.tmdb.org/t/p/w300' + m.poster_path;
            if (m.backdrop_path) return 'https://image.tmdb.org/t/p/w300' + m.backdrop_path;
            return '';
        }

        function movieMeta() {
            var m = object.movie || {};
            var year = (m.release_date || m.first_air_date || '').slice(0, 4);
            var rate = m.vote_average ? Number(m.vote_average).toFixed(1) : '';
            var info = [];
            if (year) info.push(year);
            if (rate) info.push('★ ' + rate);
            if (m.original_title && m.original_title !== m.title) info.push(m.original_title);
            else if (m.original_name && m.original_name !== m.name) info.push(m.original_name);
            return info;
        }

        function buildList() {
            html.empty();
            if (!state.info) return;
            var info = state.info;
            var poster = getPoster();
            var movieTitle = (object.movie.title || object.movie.name || '');
            var meta = movieMeta();
            var tagline = object.movie.tagline || '';
            var qualityPref = getQualityPref();
            var qualityLabel = (qualityPref && qualityPref !== 'auto') ? qualityPref : '';

            // Длительность фильма / эпизода (минуты → строка ЧЧ:ММ)
            function fmtMin(min) {
                min = parseInt(min, 10);
                if (!min || isNaN(min)) return '';
                var h = Math.floor(min / 60);
                var m = min % 60;
                if (h <= 0) return ('0:' + (m < 10 ? '0' : '') + m);
                return (h + ':' + (m < 10 ? '0' : '') + m);
            }
            var movieRuntime = fmtMin(object.movie.runtime);
            var episodeRuntime = '';
            if (object.movie.episode_run_time && object.movie.episode_run_time.length) {
                episodeRuntime = fmtMin(object.movie.episode_run_time[0]);
            }
            if (!episodeRuntime) episodeRuntime = movieRuntime;

            if (info.is_series) {
                // Сериал: одна карточка на КАЖДУЮ серию (выбранная озвучка как в фильтре).
                // По нажатию запускается плеер с плейлистом всех серий сезона —
                // переключение озвучки доступно через фильтр «Перевод».
                var voice = info.voice[state.choice.voice] || info.voice[0];
                var season = info.season[state.choice.season];
                var items = season ? info.episode.filter(function (e) {
                    return String(e.season_id) === String(season.id);
                }) : [];
                var origTitleS = (object.movie.original_name || object.movie.original_title || movieTitle || '');
                var sNumGlobal = season ? (parseInt(season.id, 10) || 0) : 0;
                var renderedCards = []; // [{card, ep, idx}] — для дообновления имён из TMDB
                // Проверяем кеш TMDB ДО отрисовки — если имена уже есть, выведём их сразу (без мелькания "Серия N").
                var cachedMap = (sNumGlobal && object.movie && object.movie.id)
                    ? _tmdbEpCache[object.movie.id + ':' + sNumGlobal]
                    : null;
                // v1.0.35: собираем прогресс Timeline для каждой серии чтобы выбрать цель автофокуса.
                var focusCandidates = []; // [{eNum, percent, time, idx, hash}]
                items.forEach(function (ep, epIdx) {
                    // Hash каждой серии индивидуален (формула lampac):
                    // [season_number, ':' если season>10, episode_number, original_title]
                    var sNum = parseInt(ep.season_id || season.id, 10) || 0;
                    var eNum = parseInt(ep.episode_id || ep.name, 10) || 0;
                    var hash = strHash([sNum, sNum > 10 ? ':' : '', eNum, origTitleS].join(''));
                    try {
                        var tlView = Lampa.Timeline ? Lampa.Timeline.view(hash) : null;
                        if (tlView) {
                            focusCandidates.push({
                                eNum: eNum,
                                percent: parseFloat(tlView.percent) || 0,
                                time: parseFloat(tlView.time) || 0,
                                idx: epIdx,
                                hash: hash
                            });
                        }
                    } catch (e) {}
                    // Имя серии: берём из кеша TMDB сразу если есть, или из ранее сохранённого ep.tmdb_name.
                    // Иначе — фолбэк "Серия N" до результата асинхронного fetchTMDBEpisodes.
                    var cachedEntry = cachedMap && cachedMap[eNum];
                    var initialName = (cachedEntry && cachedEntry.name) || ep.tmdb_name || ('Серия ' + eNum);
                    var initialPoster = (cachedEntry && cachedEntry.still) || ep.tmdb_still || poster;
                    if (cachedEntry) {
                        if (cachedEntry.name) ep.tmdb_name = cachedEntry.name;
                        if (cachedEntry.still) ep.tmdb_still = cachedEntry.still;
                    }
                    var card = makePrestigeCard({
                        title: initialName,
                        time: episodeRuntime,
                        info: [voice.name, season.name],
                        quality: qualityLabel,
                        hash: hash,
                        poster: initialPoster,
                        tagline: tagline
                    });
                    var tl = card.data('timeline');
                    card.on('hover:enter', function () { playSeries(info, voice, season, items, epIdx); });
                    card.on('hover:focus', function (e) {
                        try { scroll.update($(e.target), true); } catch (er) {}
                    });
                    // v1.0.36: длинное нажатие — меню действий (как в modss).
                    (function (epHashL, epIdxL) {
                        card.on('hover:long', function () {
                            openCardActionMenu({
                                hash: epHashL,
                                playFn: function () { playSeries(info, voice, season, items, epIdxL); }
                                // url: не знаем до запуска — без Speedtest/Копирования
                            });
                        });
                    })(hash, epIdx);
                    html.append(card);
                    renderedCards.push({ card: card, ep: ep, idx: epIdx, eNum: eNum });
                });
                // v1.0.35: выбираем серию для автофокуса:
                //  1) есть недосмотренная (0 < percent < 90) — самая поздняя среди таких;
                //  2) иначе — самая поздняя с любым прогрессом (досмотренные 100%);
                //  3) иначе — первая серия (дефолт Lampa).
                var focusCard = null;
                try {
                    var inProgress = focusCandidates.filter(function (c) { return c.percent > 0 && c.percent < 90; });
                    var watched   = focusCandidates.filter(function (c) { return c.percent > 0; });
                    var pickFromList = function (list) {
                        if (!list.length) return null;
                        // самая поздняя по номеру серии
                        list.sort(function (a, b) { return b.eNum - a.eNum; });
                        return list[0];
                    };
                    var pick = pickFromList(inProgress) || pickFromList(watched);
                    if (pick) {
                        var rc = renderedCards.filter(function (r) { return r.idx === pick.idx; })[0];
                        if (rc) focusCard = rc.card;
                        console.log('REZKA', 'autofocus episode eNum=' + pick.eNum + ' percent=' + pick.percent + ' (in_progress=' + inProgress.length + ', watched=' + watched.length + ')');
                    }
                } catch (e) { console.log('REZKA', 'autofocus pick error:', e && e.message); }
                // Отложенно фокусируем — collectionFocus должен вызываться ПОСЛЕ scroll.append + Controller.enable.
                state._pendingFocusEl = focusCard ? focusCard[0] : null;
                if (!items.length) {
                    html.append('<div style="padding:1em;color:#ccc">Без серий в этом сезоне</div>');
                }
                // Доподгружаем имена и постеры из TMDB. Если ответ был в кеше — коллбэк выполнится синхронно и это нооп.
                if (renderedCards.length && object.movie && object.movie.id && sNumGlobal) {
                    fetchTMDBEpisodes(object.movie.id, sNumGlobal, function (nameMap) {
                        if (!nameMap) return;
                        renderedCards.forEach(function (rc) {
                            var entry = nameMap[rc.eNum];
                            if (!entry) return;
                            var nm = entry.name;
                            var still = entry.still;
                            if (nm) {
                                rc.ep.tmdb_name = nm; // сохраним в ep — playSeries возьмёт оттуда
                                try {
                                    var titleEl = rc.card.find('.rezka-prestige__title, .online__title').first();
                                    if (titleEl.length) titleEl.text(nm);
                                } catch (e) {}
                            }
                            if (still && still !== rc.ep.tmdb_still) {
                                rc.ep.tmdb_still = still;
                                try {
                                    var imgWrap = rc.card.find('.rezka-prestige__img');
                                    var img = imgWrap.find('img');
                                    img.off('load').on('load', function () { imgWrap.addClass('rezka-prestige__img--loaded'); });
                                    img.attr('src', still);
                                } catch (e2) {}
                            }
                        });
                    });
                }
            } else {
                // Фильм: ОДНА карточка фильма. Все озвучки уходят в плеер как playlist —
                // в плеере кнопкой плейлиста можно переключить озвучку.
                (function () {
                    var origTitle = (object.movie.original_title || object.movie.original_name || movieTitle || '');
                    var hash = strHash(origTitle);
                    var defIdx = pickDefaultVoiceIdx(info.voice);
                    var defVoice = info.voice[defIdx] || info.voice[0] || { name: '—' };
                    var infoLine = meta.slice();
                    if (info.voice.length > 1) {
                        infoLine.push((info.voice.length) + ' озвучек');
                    } else if (defVoice.name) {
                        infoLine.push(defVoice.name);
                    }
                    var card = makePrestigeCard({
                        title: movieTitle,
                        time: movieRuntime,
                        info: infoLine,
                        quality: qualityLabel,
                        hash: hash,
                        poster: poster,
                        tagline: tagline
                    });
                    var tl = card.data('timeline');
                    card.on('hover:enter', function () {
                        playFilm(info, defIdx);
                    });
                    card.on('hover:focus', function (e) {
                        try { scroll.update($(e.target), true); } catch (er) {}
                    });
                    // v1.0.36: длинное нажатие — меню действий.
                    card.on('hover:long', function () {
                        openCardActionMenu({
                            hash: hash,
                            playFn: function () { playFilm(info, defIdx); }
                        });
                    });
                    html.append(card);
                })();
                if (!info.voice.length) {
                    html.append('<div style="padding:1em;color:#ccc">Нет доступных озвучек</div>');
                }
            }
            scroll.append(html);
            Lampa.Controller.enable('content');
            // v1.0.35: автофокус на последнюю просматривавшуюся серию (если есть прогресс).
            try {
                if (state._pendingFocusEl) {
                    var targetEl = state._pendingFocusEl;
                    state._pendingFocusEl = null;
                    // Два setTimeout чтобы: 1) дать DOM вставиться, 2) Lampa.Controller.enable успел примениться.
                    setTimeout(function () {
                        try {
                            Lampa.Controller.collectionFocus(targetEl, scroll.render());
                        } catch (er) {
                            console.log('REZKA', 'collectionFocus error:', er && er.message);
                        }
                    }, 0);
                }
            } catch (e) {}
        }

        // Качества которые отдаёт HDREZKA (порядок от лучшего к худшему).
        // Используем этот список и в sort-меню вверху, и для выбора по умолчанию в getStream.
        var QUALITY_ORDER = ['2160p Ultra', '2160p', '1440p', '1080p Ultra', '1080p', '720p', '480p', '360p'];

        // v1.0.32: качество хранится per-film. filmId — object.movie.id.
        function curFilmId() {
            try { return (object.movie && (object.movie.id || object.movie.tmdb_id)) || ''; } catch (e) { return ''; }
        }
        function getQualityPref() { return getQualityFor(curFilmId()); }
        function setQualityPref(q) { setQualityFor(curFilmId(), q); }

        /* ====================================================
         *  v1.0.36: Меню действий при длинном нажатии (hover:long) на карточку.
         *  Повторяет стандартное меню Lampa (как в modss/torrents):
         *  - Запустить плеер - Android / WebOS / Lampa
         *  - Тестировать скорость (если известен url)
         *  - Пометить / Снять отметку (timefull)
         *  - Сбросить тайм-код (timeclear)
         *
         *  Параметры:
         *  - hash: индивидуальный hash дль Timeline (для фильма или серии)
         *  - playFn: функция-запуск (playFilm/playSeries) для "Запустить плеер"
         * ==================================================== */
        function openCardActionMenu(opts) {
            try {
                var hash = opts.hash;
                var playFn = opts.playFn;
                var url = opts.url || '';   // для Speedtest и копирования — может отсутствовать до первого воспроизведения
                var view = (Lampa.Timeline && Lampa.Timeline.view) ? Lampa.Timeline.view(hash) : { percent: 0, time: 0, duration: 0 };
                var enabled = (Lampa.Controller && Lampa.Controller.enabled) ? Lampa.Controller.enabled().name : 'content';

                var T = function (k, fb) {
                    try { var s = Lampa.Lang.translate(k); return s && s !== k ? s : (fb || k); } catch (e) { return fb || k; }
                };

                var menu = [];

                // Плееры
                if (Lampa.Platform.is('android')) {
                    menu.push({ title: T('player_lauch', 'Запустить плеер') + ' - Android', player: 'android' });
                }
                if (Lampa.Platform.is('webos')) {
                    menu.push({ title: T('player_lauch', 'Запустить плеер') + ' - WebOS', player: 'webos' });
                }
                menu.push({ title: T('player_lauch', 'Запустить плеер') + ' - Lampa', player: 'lampa' });

                // Speedtest — только если есть url и Lampa.Speedtest
                if (url && Lampa.Speedtest && Lampa.Speedtest.show) {
                    menu.push({ title: T('speedtest_button', 'Тестировать скорость'), speedtest: true });
                }

                // Раздел: просмотр
                if (view.percent && view.percent >= 100) {
                    menu.push({ title: T('torrent_parser_label_cancel_title', 'Снять отметку'), timeclear: true });
                } else {
                    menu.push({ title: T('torrent_parser_label_title', 'Пометить'), timefull: true });
                }
                if (view.percent && view.percent > 0 && view.percent < 100) {
                    menu.push({ title: T('time_reset', 'Сбросить тайм-код'), timeclear: true });
                }

                // Копирование ссылки — только если есть url
                if (url) {
                    menu.push({ title: T('copy_link', 'Копировать ссылку на видео'), link: true });
                }

                Lampa.Select.show({
                    title: T('title_action', 'Действие'),
                    items: menu,
                    onBack: function () {
                        try { Lampa.Controller.toggle(enabled); } catch (e) {}
                    },
                    onSelect: function (a) {
                        try {
                            if (a.timeclear) {
                                view.percent = 0; view.time = 0; view.duration = 0;
                                if (Lampa.Timeline && Lampa.Timeline.update) Lampa.Timeline.update(view);
                                Lampa.Noty.show('HDREZKA: тайм-код сброшен');
                            }
                            if (a.timefull) {
                                view.percent = 100; view.time = view.duration || 0;
                                if (Lampa.Timeline && Lampa.Timeline.update) Lampa.Timeline.update(view);
                                Lampa.Noty.show('HDREZKA: помечено как просмотренное');
                            }
                            if (a.link && url) {
                                Lampa.Utils.copyTextToClipboard(url, function () {
                                    Lampa.Noty.show('Ссылка скопирована');
                                }, function () {
                                    Lampa.Noty.show('Не удалось скопировать');
                                });
                            }
                            if (a.speedtest && url && Lampa.Speedtest && Lampa.Speedtest.show) {
                                Lampa.Speedtest.show({ url: url });
                                return; // Speedtest сам разберётся с controller
                            }
                            try { Lampa.Controller.toggle(enabled); } catch (e) {}
                            if (a.player) {
                                // Ставим выбранный плеер и запускаем
                                try { Lampa.Player.runas(a.player); } catch (e) {}
                                if (typeof playFn === 'function') playFn();
                            }
                            // Перерисовываем карточку — обновится полоса прогресса.
                            if (a.timeclear || a.timefull) {
                                try { buildList(); } catch (e) {}
                            }
                        } catch (e) {
                            console.log('REZKA', 'action menu select error:', e && e.message);
                        }
                    }
                });
            } catch (e) {
                console.log('REZKA', 'openCardActionMenu error:', e && e.message);
            }
        }

        function buildFilter() {
            if (!state.info) return;
            var info = state.info;
            var qPref = getQualityPref();
            var qLabel = qPref === 'auto' ? 'Максимальное' : qPref;

            // Правый блок (sort) = переключатель качества. Сохраняется на следующие фильмы.
            // Используем список фактически доступных качеств, если уже получили плейлист фильма
            // (сохраняется в getStream под ключом rezka_quality_available). Иначе — полный список.
            var availableLabels = (Lampa.Storage.get('rezka_quality_available', '') || '').split(',').filter(Boolean);
            var sourceList = availableLabels.length ? availableLabels : QUALITY_ORDER;
            var qualityItems = [{ title: 'Максимальное', value: 'auto', selected: qPref === 'auto' }]
                .concat(sourceList.map(function (q) {
                    return { title: q, value: q, selected: qPref === q };
                }));
            try { filter.set('sort', qualityItems); } catch (e) {}
            try { filter.chosen('sort', [qLabel]); } catch (e) {}
            // Переименование «Сортировать» → «Качество» (только в нашем компоненте)
            try {
                var $sortBtn = files.render().find('.filter--sort > span').first();
                if ($sortBtn.length && $sortBtn.text() !== 'Качество') $sortBtn.text('Качество');
            } catch (e) {}

            // Левый блок (filter) = Перевод (+Сезон для сериала)
            var select = [];
            var chosen = [];
            if (info.voice && info.voice.length) {
                var vName = (info.voice[state.choice.voice] || info.voice[0] || {}).name || '—';
                var voiceItems = info.voice.map(function (v, i) {
                    return { title: v.name, selected: i === state.choice.voice, index: i };
                });
                select.push({ title: 'Перевод', subtitle: vName, items: voiceItems, stype: 'voice' });
                chosen.push('Перевод: ' + vName);
            }
            if (info.is_series && info.season.length) {
                var sName = (info.season[state.choice.season] || {}).name || '—';
                var seasonItems = info.season.map(function (s, i) {
                    return { title: s.name, selected: i === state.choice.season, index: i };
                });
                select.push({ title: 'Сезон', subtitle: sName, items: seasonItems, stype: 'season' });
                chosen.push('Сезон: ' + sName);
            }
            select.push({ title: 'Сбросить', reset: true });
            try { filter.set('filter', select); } catch (e) {}
            try { filter.chosen('filter', chosen); } catch (e) {}
            try { filter.toggle && filter.toggle(); } catch (e) {}

            filter.onSelect = function (type, a, b) {
                if (type === 'sort') {
                    // выбор качества — без под-меню, сразу a
                    if (a && a.value) {
                        setQualityPref(a.value);
                        setTimeout(Lampa.Select.close, 10);
                        buildFilter();
                        buildList();
                    }
                    return;
                }
                if (type !== 'filter') return;
                if (a.reset) {
                    state.choice.voice = pickDefaultVoiceIdx(info.voice);
                    state.choice.season = 0;
                    setTimeout(Lampa.Select.close, 10);
                    buildFilter();
                    buildList();
                    return;
                }
                if (a.stype === 'voice' && b && typeof b.index !== 'undefined') {
                    state.choice.voice = b.index;
                    // ПРИ СМЕНЕ ПЕРЕВОДЧИКА: разные переводы покрывают разные сезоны/серии.
                    // HTML страницы содержит сезоны только для дефолтного переводчика —
                    // для остальных нужно дозапросить через ajax/get_cdn_series action=get_episodes.
                    if (info.is_series) {
                        // Запоминаем текущий сезон — чтобы reloadEpisodesForVoice постарался остаться на нём.
                        var prevSeason = info.season && info.season[state.choice.season];
                        var prevSeasonId = prevSeason ? prevSeason.id : null;
                        setTimeout(Lampa.Select.close, 10);
                        reloadEpisodesForVoice(info.voice[state.choice.voice], prevSeasonId, function () {
                            buildFilter();
                            buildList();
                        });
                        return;
                    }
                } else if (a.stype === 'season' && b && typeof b.index !== 'undefined') {
                    state.choice.season = b.index;
                    // v1.0.32: запоминаем выбранный сезон per-film.
                    try {
                        var sObj = info.season[b.index];
                        if (sObj && sObj.id) {
                            setSavedSeason(curFilmId(), sObj.id);
                            console.log('REZKA', 'saved season id=' + sObj.id + ' for filmId=' + curFilmId());
                        }
                    } catch (e) {}
                }
                setTimeout(Lampa.Select.close, 10);
                buildFilter();
                buildList();
            };
        }

        // Перезагружает info.season и info.episode для выбранного переводчика
        // через ajax/get_cdn_series action=get_episodes.
        // Дело в том, что разные переводчики на rezka покрывают разные сезоны
        // (например Дубляж неоф. у Сериала 31432 есть только для Сезона 5).
        function reloadEpisodesForVoice(voice, preferredSeasonId, done) {
            // Совместимость: второй арг может быть done-коллбэком (старый вызов).
            if (typeof preferredSeasonId === 'function' && typeof done === 'undefined') {
                done = preferredSeasonId; preferredSeasonId = null;
            }
            var info = state && state.info;
            if (!info) {
                console.log('REZKA', 'reloadEpisodesForVoice: пропускаю — state.info пуст');
                try { Lampa.Noty.show('HDREZKA: нет данных фильма для смены озвучки'); } catch (e) {}
                done && done();
                return;
            }
            if (!voice || !voice.id || !info.film_id) {
                console.log('REZKA', 'reloadEpisodesForVoice: пропускаю — нет voice/film_id');
                done && done();
                return;
            }
            console.log('REZKA', 'reloadEpisodesForVoice tid=' + voice.id + ' film_id=' + info.film_id);
            var url = proxify(getDomain() + '/ajax/get_cdn_series/?t=' + Date.now());
            var post = 'id=' + encodeURIComponent(info.film_id) +
                       '&translator_id=' + encodeURIComponent(voice.id) +
                       '&favs=' + encodeURIComponent(info.favs || '') +
                       '&action=get_episodes';
            request({
                url: url,
                post: post,
                dataType: 'text',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': getDomain(),
                    'Referer': getDomain() + '/'
                }
            }, function (resp) {
                var rawHead = '';
                try { rawHead = (typeof resp === 'string' ? resp : JSON.stringify(resp)).slice(0, 300); } catch (e0) {}
                console.log('REZKA', 'reloadEpisodesForVoice raw:', rawHead);
                try {
                    var json = typeof resp === 'string' ? JSON.parse(resp) : resp;
                    if (!json || !json.success) {
                        var srvMsg = (json && (json.message || json.error)) || 'неизвестная ошибка';
                        console.log('REZKA', 'reloadEpisodesForVoice fail:', srvMsg, 'tid=' + voice.id, 'fid=' + info.film_id);
                        try { Lampa.Noty.show('HDREZKA: смена озвучки — ' + srvMsg + ' [tid=' + voice.id + ' fid=' + info.film_id + ']'); } catch (e1) {}
                        // Оставим исходные seasons/episodes — пусть пользователь видит бывшие.
                        done && done();
                        return;
                    }
                    // Разбираем seasons и episodes из ajax-ответа.
                    var newSeasons = [];
                    var newEpisodes = [];
                    var d1 = document.createElement('div');
                    d1.innerHTML = '<ul>' + (json.seasons || '') + '</ul>';
                    d1.querySelectorAll('.b-simple_season__item').forEach(function (li) {
                        newSeasons.push({
                            name: (li.textContent || '').trim(),
                            id: li.getAttribute('data-tab_id')
                        });
                    });
                    var d2 = document.createElement('div');
                    d2.innerHTML = (json.episodes || '');
                    d2.querySelectorAll('.b-simple_episode__item').forEach(function (li) {
                        newEpisodes.push({
                            name: (li.textContent || '').trim(),
                            season_id: li.getAttribute('data-season_id'),
                            episode_id: li.getAttribute('data-episode_id')
                        });
                    });
                    if (newSeasons.length) info.season = newSeasons;
                    if (newEpisodes.length) info.episode = newEpisodes;
                    console.log('REZKA', 'reloadEpisodesForVoice: получено ' + newSeasons.length + ' сезонов, ' + newEpisodes.length + ' эпизодов' + (preferredSeasonId ? ', хотели season=' + preferredSeasonId : ''));
                    // Пытаемся остаться на том же сезоне, что был выбран до смены озвучки.
                    // Если у новой озвучки этого сезона нет — берём последний из доступных.
                    var matchedIdx = -1;
                    if (preferredSeasonId != null) {
                        for (var si = 0; si < info.season.length; si++) {
                            if (String(info.season[si].id) === String(preferredSeasonId)) { matchedIdx = si; break; }
                        }
                    }
                    if (matchedIdx >= 0) {
                        state.choice.season = matchedIdx;
                        console.log('REZKA', 'reloadEpisodesForVoice: сезон ' + preferredSeasonId + ' найден в новой озвучке (idx=' + matchedIdx + ')');
                    } else {
                        state.choice.season = info.season.length ? info.season.length - 1 : 0;
                        if (preferredSeasonId != null) {
                            console.log('REZKA', 'reloadEpisodesForVoice: сезон ' + preferredSeasonId + ' НЕТ у новой озвучки, ухожу на последний (idx=' + state.choice.season + ')');
                        }
                    }
                } catch (e) {
                    console.log('REZKA', 'reloadEpisodesForVoice parse error:', e && e.message, 'raw=', rawHead);
                    try { Lampa.Noty.show('HDREZKA: ошибка парсинга ответа смены озвучки — ' + (e && e.message)); } catch (e2) {}
                }
                done && done();
            }, function (xhr, msg) {
                var st = (xhr && (xhr.status || xhr.statusCode)) || '?';
                console.log('REZKA', 'reloadEpisodesForVoice network fail:', msg, 'status=', st);
                try { Lampa.Noty.show('HDREZKA: сеть упала при смене озвучки [status=' + st + '] ' + (msg || '')); } catch (e3) {}
                done && done();
            });
        }

        // Выбирает индекс дубляжа среди озвучек (дефолт — первая)
        function pickDefaultVoiceIdx(voices) {
            if (!voices || !voices.length) return 0;
            for (var i = 0; i < voices.length; i++) {
                if (/дубляж|dub/i.test(voices[i].name)) return i;
            }
            return 0;
        }

        // Подписываемся на:
        //  - 'available'  — пришёл фактический список качеств после первого getStream;
        //  - 'changed'    — v1.0.34: пользователь выбрал качество в плеере → обновляем отображение.
        var qualityListener = function (e) {
            if (!e) return;
            if (e.type === 'available') {
                try { buildFilter(); } catch (er) {}
            } else if (e.type === 'changed') {
                // Обновляем только если это событие о текущем фильме.
                try {
                    var myId = curFilmId();
                    if (!e.filmId || String(e.filmId) === String(myId)) {
                        buildFilter();
                        buildList();
                    }
                } catch (er) {}
            }
        };
        try { Lampa.Listener.follow('rezka_quality', qualityListener); } catch (e) {}

        this.destroy = function () {
            try { Lampa.Listener.remove('rezka_quality', qualityListener); } catch (e) {}
            try { network.clear(); } catch (e) {}
            try { scroll.destroy(); } catch (e) {}
            try { files.destroy(); } catch (e) {}
            try { filter.destroy && filter.destroy(); } catch (e) {}
            html.remove();
        };

        this.initialize = function () {
            this.activity.loader(true);
            // сбрасываем список фактически доступных качеств — это новый фильм
            try { Lampa.Storage.set('rezka_quality_available', ''); } catch (e) {}

            var movie = object.movie || {};
            var title = movie.title || movie.name || '';
            var origTitle = movie.original_title || movie.original_name || '';
            var year = (movie.release_date || movie.first_air_date || '').slice(0, 4);
            console.log('REZKA', 'component initialize. movie.title=', title, 'origTitle=', origTitle, 'year=', year, 'domain=', getDomain(), 'logged=', isLoggedIn());

            // Внутренняя: обрабатываем info после fetchFilmPage — выделено в v1.0.28 для повторного использования при rezka_url override
            var onFilmInfo = function (info) {
                    state.info = info;
                    state.choice.voice = pickDefaultVoiceIdx(info.voice);
                    // Для сериала — v1.0.32: пытаемся восстановить сохранённый сезон (rezka_season_<filmId>),
                    // иначе — последний сезон.
                    if (info.is_series && info.season.length) {
                        var defaultSeasonIdx = info.season.length - 1;
                        var savedSeasonId = getSavedSeason(curFilmId());
                        if (savedSeasonId) {
                            for (var ssi = 0; ssi < info.season.length; ssi++) {
                                if (String(info.season[ssi].id) === String(savedSeasonId)) {
                                    defaultSeasonIdx = ssi;
                                    console.log('REZKA', 'restored saved season idx=' + ssi + ' id=' + savedSeasonId + ' for filmId=' + curFilmId());
                                    break;
                                }
                            }
                        }
                        state.choice.season = defaultSeasonIdx;
                        // Предзагружаем TMDB-имена/постеры всех сезонов в фоне
                        // — при переключении сезона карточки сразу покажут имена без мелькания "Серия N".
                        if (object.movie && object.movie.id) {
                            try {
                                info.season.forEach(function (s, idx) {
                                    var sNum = parseInt(s.id, 10) || (idx + 1);
                                    setTimeout(function () {
                                        fetchTMDBEpisodes(object.movie.id, sNum, function () {});
                                    }, idx * 80); // лёгкий stagger — не ложим TMDB одновременными запросами
                                });
                            } catch (e) { console.log('REZKA', 'TMDB prefetch error:', e && e.message); }
                        }
                    }
                    self.activity.loader(false);
                    // ФИЛЬМ (не сериал): пользователь нажал «HDREZKA» и ожидает немедленного воспроизведения.
                    // Карточка-промежуток была бы лишним кликом — сразу запускаем плеер и выкатываемся назад.
                    if (!info.is_series) {
                        if (!info.voice || !info.voice.length) {
                            showError('Нет доступных озвучек');
                            self.activity.toggle();
                            return;
                        }
                        var defIdx = pickDefaultVoiceIdx(info.voice);
                        console.log('REZKA', 'auto-play film: пропускаю экран выбора, запускаю playFilm(defIdx=' + defIdx + ')');
                        try { playFilm(info, defIdx); } catch (e) {
                            console.log('REZKA', 'auto-play film error:', e && e.message);
                            showError('Не удалось запустить воспроизведение: ' + (e && e.message));
                            self.activity.toggle();
                            return;
                        }
                        // Убираем невидимый activity из стека — чтобы при выходе из плеера
                        // пользователь вернулся сразу на карточку фильма, а не на пустой экран плагина.
                        setTimeout(function () {
                            try { Lampa.Activity.backward(); } catch (e2) {
                                console.log('REZKA', 'Activity.backward error:', e2 && e2.message);
                            }
                        }, 100);
                        return;
                    }
                    buildFilter();
                    buildList();
                    self.activity.toggle();
            };
            var onFilmErr = function (xhr, msg) {
                    self.activity.loader(false);
                    var status = (xhr && xhr.status) || 0;
                    var text;
                    if (status === 401 || msg === 'login required') {
                        text = 'HDREZKA требует вход. Откройте Настройки → HDREZKA → "Cookie (ручной вход)" и вставьте dle_user_id=...; dle_password=... из браузера.';
                    } else {
                        text = 'Ошибка загрузки страницы фильма' + (msg ? ': ' + msg : '');
                    }
                    showError(text);
                    self.activity.toggle();
            };

            // v1.0.28 §5: если пользователь выбрал конкретный вариант в chooser — пропускаем поиск, идём прямо на URL
            if (object.rezka_url) {
                console.log('REZKA', 'initialize: using preselected rezka_url=', object.rezka_url);
                fetchFilmPage(object.rezka_url, onFilmInfo, onFilmErr);
                return;
            }

            // v1.0.37: каскадный поиск, чтобы не открывать фильм другого года.
            // Симптом: «На помощь!» (2026, Send Help) — по русскому названию HDREZKA отдаёт
            // фильмы 1988/2012/2011/2019/2000 (ни один не 2026), старый код брал results[0].
            // Новый алгоритм:
            //   1) русское + strict-year     → если есть — открываем [0]
            //   2) original + strict-year      → если есть — открываем [0]
            //   3) русское без фильтра    → если есть — chooser (выбор вручную)
            //   4) original без фильтра     → если есть — chooser
            //   5) иначе — ошибка «Ничего не найдено»

            // встроенный chooser — переоткрываем текущий activity с rezka_url выбранного варианта
            var showChooser = function (sourceQuery, results) {
                self.activity.loader(false);
                var items = results.map(function (r) {
                    var subtitle = r.details ? r.details : (r.year || '');
                    return {
                        title: r.title + (r.year ? '  (' + r.year + ')' : ''),
                        subtitle: subtitle,
                        __res: r
                    };
                });
                console.log('REZKA', 'initialize: chooser triggered, sourceQuery=', sourceQuery, 'results=', results.length);
                Lampa.Select.show({
                    title: 'HDREZKA: выберите вариант (точное совпадение не найдено)',
                    items: items,
                    onBack: function () {
                        try { Lampa.Activity.backward(); } catch (e) {}
                    },
                    onSelect: function (a) {
                        var r = a.__res;
                        console.log('REZKA', 'chooser-init: selected url=', r.url, 'title=', r.title, 'year=', r.year);
                        // закрываем текущий пустой activity и открываем новый с rezka_url
                        try { Lampa.Activity.backward(); } catch (e) {}
                        setTimeout(function () {
                            openRezka(movie, { rezka_url: r.url, titleSuffix: r.title + (r.year ? ' ' + r.year : '') });
                        }, 50);
                    }
                });
            };

            // Шаг 1: русское + strict-year
            searchRezka(title, year, function (resultsRu) {
                if (resultsRu.length) {
                    console.log('REZKA', 'search step1 (ru+strict-year): match found, opening', resultsRu[0].url);
                    fetchFilmPage(resultsRu[0].url, onFilmInfo, onFilmErr);
                    return;
                }
                // Шаг 2: original + strict-year
                var hasOrig = origTitle && origTitle !== title;
                var step2 = function (next) {
                    if (!hasOrig) { next([]); return; }
                    searchRezka(origTitle, year, next, { strict: true });
                };
                step2(function (resultsEn) {
                    if (resultsEn.length) {
                        console.log('REZKA', 'search step2 (en+strict-year): match found, opening', resultsEn[0].url);
                        fetchFilmPage(resultsEn[0].url, onFilmInfo, onFilmErr);
                        return;
                    }
                    // Шаг 3: русское без фильтра
                    searchRezka(title, 'all', function (resultsAllRu) {
                        if (resultsAllRu.length) {
                            showChooser(title, resultsAllRu);
                            return;
                        }
                        // Шаг 4: original без фильтра
                        if (hasOrig) {
                            searchRezka(origTitle, 'all', function (resultsAllEn) {
                                if (resultsAllEn.length) {
                                    showChooser(origTitle, resultsAllEn);
                                    return;
                                }
                                self.activity.loader(false);
                                showError('Ничего не найдено на HDREZKA по «' + title + '» / «' + origTitle + '»');
                                self.activity.toggle();
                            });
                        } else {
                            self.activity.loader(false);
                            showError('Ничего не найдено на HDREZKA');
                            self.activity.toggle();
                        }
                    });
                });
            }, { strict: true });
        };
    }

    /* ====================================================
     *  Register component & online source button
     * ==================================================== */
    /* ====================================================
     *  Prestige template & CSS — оформление карточек
     *  в стиле lampac/online-prestige (постер + таймлайн + инфо)
     * ==================================================== */
    function registerPrestigeStyles() {
        if (window.rezka_prestige_registered) return;
        window.rezka_prestige_registered = true;
        try {
            Lampa.Template.add('rezka_prestige_css', '<style>'
                + '.rezka-prestige{position:relative;border-radius:.3em;background-color:rgba(0,0,0,0.3);display:flex;}'
                + '.rezka-prestige+.rezka-prestige{margin-top:1.5em}'
                + '.rezka-prestige__img{position:relative;width:13em;flex-shrink:0;min-height:8.2em;border-radius:.3em;overflow:hidden;background:#222;}'
                + '.rezka-prestige__img>img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .3s;}'
                + '.rezka-prestige__img--loaded>img{opacity:1}'
                + '.rezka-prestige__body{padding:1.2em;line-height:1.3;flex-grow:1;position:relative;display:flex;flex-direction:column;justify-content:space-between;}'
                + '.rezka-prestige__head{display:flex;justify-content:space-between;align-items:center}'
                + '.rezka-prestige__title{font-size:1.7em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}'
                + '.rezka-prestige__time{padding-left:2em;color:rgba(255,255,255,0.6);font-size:1.1em;white-space:nowrap}'
                + '.rezka-prestige__timeline{margin:.7em 0 .35em 0}'
                + '.rezka-prestige__timeline>.time-line{display:block !important;width:100%}'
                + '.rezka-prestige__details{font-size:.9em;color:rgba(255,255,255,0.85);margin-bottom:.4em}'
                + '.rezka-prestige__details .time-line-details{display:block !important}'
                + '.rezka-prestige__details.hide{display:none}'
                + '.rezka-prestige__footer{display:flex;justify-content:space-between;align-items:center;margin-top:auto}'
                + '.rezka-prestige__info{display:flex;align-items:center;color:rgba(255,255,255,0.7);font-size:.9em;flex-wrap:wrap;gap:0;}'
                + '.rezka-prestige__info>*{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}'
                + '.rezka-prestige__info .tagline{font-style:italic;color:rgba(255,255,255,0.85)}'
                + '.rezka-prestige__quality{padding-left:1em;white-space:nowrap;color:#fff;font-weight:600;font-size:.95em}'
                + '.rezka-prestige-split{font-size:.8em;margin:0 .8em;flex-shrink:0;opacity:.5}'
                + '.rezka-prestige.focus::after{content:"";position:absolute;top:-0.6em;left:-0.6em;right:-0.6em;bottom:-0.6em;border-radius:.7em;border:solid .3em #fff;z-index:-1;pointer-events:none}'
                + '@media screen and (max-width:480px){.rezka-prestige__img{width:7em;min-height:6em}.rezka-prestige__title{font-size:1.4em}.rezka-prestige__body{padding:.8em 1.2em}}'
                + '</style>');
            Lampa.Template.add('rezka_prestige_full',
                '<div class="rezka-prestige selector">'
              + '<div class="rezka-prestige__img"><img alt=""></div>'
              + '<div class="rezka-prestige__body">'
              + '<div class="rezka-prestige__head">'
              + '<div class="rezka-prestige__title">{title}</div>'
              + '<div class="rezka-prestige__time">{time}</div>'
              + '</div>'
              + '<div class="rezka-prestige__timeline"></div>'
              + '<div class="rezka-prestige__details hide"></div>'
              + '<div class="rezka-prestige__footer">'
              + '<div class="rezka-prestige__info">{info}</div>'
              + '<div class="rezka-prestige__quality">{quality}</div>'
              + '</div>'
              + '</div>'
              + '</div>');
            // встраиваем CSS в <head>
            $('body').append(Lampa.Template.get('rezka_prestige_css', {}, true));
        } catch (e) { console.log('REZKA', 'prestige register fail', e && e.message); }
    }

    function registerComponent() {
        if (Lampa.Component && Lampa.Component.add) {
            Lampa.Component.add('rezka_online', component);
        }
    }

    function openRezka(movie, opts) {
        opts = opts || {};
        var name = movie.title || movie.name || '';
        var titleSuffix = opts.titleSuffix ? ' • ' + opts.titleSuffix : '';
        var act = {
            url: '',
            title: 'HDREZKA - ' + name + titleSuffix,
            component: 'rezka_online',
            search: name,            // выводится в лупе фильтра
            search_one: name,
            search_two: movie.original_title || movie.original_name || '',
            movie: movie,
            page: 1
        };
        if (opts.rezka_url) act.rezka_url = opts.rezka_url;
        Lampa.Activity.push(act);
    }

    /* ====================================================
     *  v1.0.28 §5: long-press chooser — показываем все варианты и окно поиска.
     *  Поиск без фильтра по году (year='all'), чтобы увидеть все версии (Мумия 1999/2026/etc).
     * ==================================================== */
    function chooserFor(movie) {
        var name = movie.title || movie.name || '';
        var origName = movie.original_title || movie.original_name || '';

        function showResults(query, results) {
            if (!results.length) {
                Lampa.Noty.show('HDREZKA: ничего не найдено по «' + query + '»');
                openSearchInput();
                return;
            }
            var items = [];
            // Первым пунктом — ввод другого запроса
            items.push({ title: '🔍 Другой запрос…', __search: true });
            results.forEach(function (r) {
                var subtitle = r.details ? r.details : (r.year || '');
                items.push({ title: r.title + (r.year ? '  (' + r.year + ')' : ''), subtitle: subtitle, __res: r });
            });
            Lampa.Select.show({
                title: 'HDREZKA: выберите вариант',
                items: items,
                onBack: function () { Lampa.Controller.toggle('content'); },
                onSelect: function (a) {
                    if (a.__search) { openSearchInput(); return; }
                    var r = a.__res;
                    console.log('REZKA', 'chooser: selected url=', r.url, 'title=', r.title, 'year=', r.year);
                    openRezka(movie, { rezka_url: r.url, titleSuffix: r.title + (r.year ? ' ' + r.year : '') });
                }
            });
        }

        function openSearchInput() {
            var initial = name;
            try {
                Lampa.Input.edit({
                    free: true,
                    nosave: true,
                    value: initial,
                    title: 'HDREZKA — поиск',
                    layout: 'full'
                }, function (val) {
                    val = (val || '').trim();
                    if (!val) { Lampa.Controller.toggle('content'); return; }
                    Lampa.Noty.show('HDREZKA: ищу «' + val + '»…');
                    searchRezka(val, 'all', function (results) { showResults(val, results); });
                });
            } catch (e) {
                console.log('REZKA', 'Input.edit unavailable, fallback', e && e.message);
                searchRezka(name, 'all', function (results) { showResults(name, results); });
            }
        }

        // Старт — ищем по основному названию, потом по оригинальному если пусто
        Lampa.Noty.show('HDREZKA: ищу все варианты…');
        searchRezka(name, 'all', function (results) {
            if (!results.length && origName && origName !== name) {
                searchRezka(origName, 'all', function (r2) { showResults(origName, r2); });
            } else {
                showResults(name, results);
            }
        });
    }

    function addOnlineSource() {
        // Регистрация в Lampa.Online (источник в стандартной кнопке «Онлайн»)
        var source = {
            title: 'HDREZKA',
            search: function (movie, oncomplite) {
                openRezka(movie);
                oncomplite && oncomplite([]);
            },
            onContextMenu: function () { return { name: 'HDREZKA' }; }
        };
        if (Lampa.Online && Lampa.Online.register) {
            Lampa.Online.register('rezka', source);
        }
    }

    /* ====================================================
     *  Кнопка «HDREZKA» прямо в карточке фильма
     *  Вставляется сразу после кнопки «Смотреть» (.view--torrent),
     *  как это делают популярные плагины modss / online_mod.
     * ==================================================== */
    function addCardButton() {
        var styleId = 'rezka-plugin-style';
        if (!document.getElementById(styleId)) {
            var st = document.createElement('style');
            st.id = styleId;
            st.innerHTML =
                '.full-start__button.view--rezka,.full-start-new__buttons-button.view--rezka{background:linear-gradient(135deg,#1d8a3a,#0f5e25);color:#fff}' +
                '.view--rezka .button__icon{margin-right:.4em;vertical-align:middle}' +
                '.view--rezka span{vertical-align:middle}';
            document.head.appendChild(st);
        }

        function buildButton(movie) {
            var label = '<svg class="button__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<path d="M9 8l6 4-6 4V8z" fill="currentColor"/></svg>' +
                '<span>HDREZKA</span>';

            // Используем универсальный класс selector — Lampa сама подхватит фокус
            var btn = $('<div class="full-start__button selector view--online view--rezka">' + label + '</div>');
            btn.on('hover:enter', function () { openRezka(movie); });
            // v1.0.28 §5: долгое нажатие → chooser вариантов + поиск
            btn.on('hover:long', function () {
                console.log('REZKA', 'green button long-press → chooser');
                chooserFor(movie);
            });
            return btn;
        }

        function insertButton(activityRender, movie) {
            if (!activityRender || !movie) return false;
            var activity = activityRender;
            // Если кнопка уже есть — выходим
            if (activity.find('.view--rezka').length) return true;

            var btn = buildButton(movie);

            // Логика вставки скопирована из modss/online_mod — работает на всех темах (CUB, классическая, full-start-new)
            try {
                if (activity.find('.button--priority').length) {
                    // CUB-тема с кнопкой-приоритетом — вставляем в начало блока кнопок
                    activity.find('.full-start-new__buttons').prepend(btn);
                } else if (activity.find('.button--play').length) {
                    // CUB-тема: кнопка Play — это круглый «воспроизвести». Ставим рядом.
                    if (activity.find('.full-start__button').length) {
                        activity.find('.full-start__button').first().before(btn);
                    } else {
                        activity.find('.button--play').before(btn);
                    }
                } else if (activity.find('.view--torrent').length) {
                    // Классическая вёрстка — рядом со «Смотреть» (торренты)
                    activity.find('.view--torrent').before(btn);
                } else if (activity.find('.full-start-new__buttons').length) {
                    activity.find('.full-start-new__buttons').prepend(btn);
                } else if (activity.find('.full-start__buttons').length) {
                    activity.find('.full-start__buttons').prepend(btn);
                } else {
                    return false;
                }
            } catch (err) {
                console.log('REZKA', 'insertButton fail', err);
                return false;
            }

            // Фокус СПЕЦИАЛЬНО НЕ ПЕРЕСТАВЛЯЕМ и controller НЕ трогаем.
            // Иначе другие online-плагины (modss, online_mod и т.п.) не успевают
            // вставить свои кнопки (они подгружаются POST-запросом со задержкой).
            // Первая кнопка в контейнере и так получит фокус по умолчанию.
            return true;
        }

        // Подписка на основное событие отрисовки карточки
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;
            try {
                var rendered = e.object.activity.render();
                var movie = e.data.movie;
                // Первая попытка — сразу
                insertButton(rendered, movie);
                // Вторая попытка через 1.5с — если при первой попытке кнопки
                // .button--play / .button--priority ещё не было (вёрстка CUB рендерится асинхронно),
                // вставим повторно — функция сама проверяет дублирование.
                setTimeout(function () { insertButton(rendered, movie); }, 1500);
            } catch (err) {
                console.log('REZKA', 'addCardButton complite error', err);
            }
        });

        // Если плагин загрузился ПОСЛЕ того, как карточка уже была отрисована
        try {
            var act = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
            if (act && act.component === 'full' && act.activity) {
                insertButton(act.activity.render(), act.card || (act.activity.render && act.activity.render().data && act.activity.render().data('movie')));
            }
        } catch (e) { /* noop */ }
    }

    /* ====================================================
     *  Settings panel: domain / login / password / login
     * ==================================================== */
    function statusLabel() {
        var s = Lampa.Storage.get(STORAGE.status) || 'guest';
        var ck = (Lampa.Storage.get(STORAGE.cookie) || '').trim();
        var ts = parseInt(Lampa.Storage.get(STORAGE.loginTs, 0), 10) || 0;
        if (s === 'logged') {
            var info = '';
            if (ck.indexOf('[android-session') === 0) {
                info = ' · cookies в jar (Android)';
            } else if (/dle_user_id=/.test(ck)) {
                info = ' · cookies: ' + ck.length + ' байт';
            }
            if (ts) {
                var hours = Math.floor((Date.now() - ts) / 3600000);
                if (hours < 1) info += ' · обновлены только что';
                else if (hours < 24) info += ' · возраст ' + hours + 'ч';
                else info += ' · возраст ' + Math.floor(hours/24) + 'д';
            }
            return '🟢 Вы вошли' + info;
        }
        if (s.indexOf('error:') === 0) return '🔴 Ошибка: ' + s.substring(6);
        return '⚪ Не авторизованы';
    }

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'rezka',
            name: 'HDREZKA',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<path d="M4 4h16v16H4z" stroke="currentColor" stroke-width="2"/>' +
                '<path d="M9 8l6 4-6 4V8z" fill="currentColor"/></svg>'
        });

        // ── Статус сессии ────────────────────────────────────────────
        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_status_view', type: 'trigger' },
            field: { name: 'Статус', description: statusLabel() },
            onChange: function () {
                $('[data-name="rezka_status_view"] .settings-param__descr').text(statusLabel());
            }
        });

        // ── Домен ────────────────────────────────────────────────────
        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.domain, type: 'input', values: '', default: 'https://rezka.fi' },
            field: { name: 'Домен HDREZKA', description: 'По умолчанию rezka.fi. Можно сменить на рабочее зеркало.' },
            onChange: function () { Lampa.Storage.set(STORAGE.status, 'guest'); }
        });

        // ── РЕЗЕРВНЫЙ путь: вход по Cookie (заполняется автоматически после логина) ───────
        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.cookie, type: 'input', values: '', default: '' },
            field: {
                name: '🔑 Cookie',
                description: 'Заполняется автоматически после входа. Или вставьте вручную: dle_user_id=12345; dle_password=...'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_apply_cookie_button', type: 'trigger' },
            field: { name: '✅ Применить cookie', description: 'Сохранить и проверить сессию' },
            onChange: function () {
                var ck = (Lampa.Storage.get(STORAGE.cookie) || '').trim();
                Lampa.Noty.show('Проверяю сессию HDREZKA…');
                applyManualCookie(ck, function (ok, msg) {
                    Lampa.Noty.show((ok ? '✓ ' : '✗ ') + msg);
                    $('[data-name="rezka_status_view"] .settings-param__descr').text(statusLabel());
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_help_button', type: 'trigger' },
            field: { name: '📖 Как получить cookie', description: 'Нажмите чтобы показать пошаговую инструкцию' },
            onChange: function () {
                var help =
                    '1) Откройте rezka.fi в Chrome на компьютере и войдите в аккаунт. ' +
                    '2) Нажмите F12 → Application → Cookies → https://rezka.fi. ' +
                    '3) Скопируйте значения dle_user_id и dle_password. ' +
                    '4) Вернитесь в Lampa, в поле выше вставьте: dle_user_id=ВАШ_ID; dle_password=ВАШ_ХЭШ ' +
                    '5) Нажмите «Применить cookie». Cookie живёт ~6 месяцев.';
                if (Lampa.Modal && Lampa.Modal.open) {
                    Lampa.Modal.open({
                        title: 'Как получить cookie HDREZKA',
                        html: $('<div style="padding:1em 1.5em;line-height:1.5em;font-size:1.1em">' +
                                '<p><b>1.</b> Откройте <b>rezka.fi</b> в Chrome/Firefox на компьютере и войдите в аккаунт.</p>' +
                                '<p><b>2.</b> Нажмите <b>F12</b> → вкладка <b>Application</b> (или <b>Storage</b>) → <b>Cookies</b> → <b>https://rezka.fi</b>.</p>' +
                                '<p><b>3.</b> Скопируйте значения двух cookies:</p>' +
                                '<ul style="margin-left:2em"><li><code>dle_user_id</code> (число)</li><li><code>dle_password</code> (длинная строка)</li></ul>' +
                                '<p><b>4.</b> Вернитесь в Lampa, в поле <b>«🔑 Cookie из браузера»</b> вставьте строку:</p>' +
                                '<pre style="background:#222;padding:0.6em;border-radius:0.4em">dle_user_id=12345; dle_password=abc123def456</pre>' +
                                '<p><b>5.</b> Нажмите <b>«✅ Применить cookie»</b>. Статус должен стать 🟢.</p>' +
                                '<p style="opacity:0.7">Cookie живёт ~6 месяцев — потом повторите шаги 1–4.</p>' +
                                '</div>'),
                        size: 'medium',
                        onBack: function () { Lampa.Modal.close(); Lampa.Controller.toggle('settings_component'); }
                    });
                } else {
                    Lampa.Noty.show(help);
                }
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_logout_button', type: 'trigger' },
            field: { name: '🚪 Выйти / очистить сессию', description: 'Удалить сохранённое cookie' },
            onChange: function () {
                logout();
                Lampa.Storage.set(STORAGE.cookie, '');
                Lampa.Noty.show('Сессия HDREZKA очищена');
                $('[data-name="rezka_status_view"] .settings-param__descr').text(statusLabel());
            }
        });

        // ── ОСНОВНОЙ путь: логин по логину/паролю (cookies подхватятся и запишутся в поле Cookie выше) ──
        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.login, type: 'input', values: '', default: '' },
            field: { name: '👤 Логин / E-mail', description: 'Email или имя пользователя HDREZKA' }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.password, type: 'input', values: '', default: '' },
            field: { name: '🔒 Пароль', description: 'Хранится локально на устройстве' }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_login_button', type: 'trigger' },
            field: { name: '✅ Войти в аккаунт', description: 'Сессия будет обновляться автоматически раз в 3 дня' },
            onChange: function () {
                var login = (Lampa.Storage.get(STORAGE.login) || '').trim();
                var pwd   = (Lampa.Storage.get(STORAGE.password) || '').trim();
                if (!login || !pwd) {
                    Lampa.Noty.show('Введите логин и пароль');
                    return;
                }
                Lampa.Noty.show('HDREZKA: вход…');
                authenticate(login, pwd, function (ok, msg) {
                    Lampa.Noty.show((ok ? '✓ ' : '✗ ') + msg);
                    try {
                        $('[data-name="rezka_status_view"] .settings-param__descr').text(statusLabel());
                        // Обновляем видимое значение cookie-поля
                        var ck = Lampa.Storage.get(STORAGE.cookie) || '';
                        var cookieRow = $('[data-name="' + STORAGE.cookie + '"]');
                        cookieRow.find('.settings-param__value').text(ck);
                        cookieRow.find('input').val(ck);
                    } catch (e) {}
                });
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.proxy, type: 'input', values: '', default: '' },
            field: {
                name: 'CORS-прокси (опц.)',
                description: 'Если HDREZKA блокируется CORS, можно указать прокси, например https://your-proxy.com/'
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_test_session_button', type: 'trigger' },
            field: { name: 'Проверить сессию', description: 'Делает запрос к HDREZKA и показывает HTTP-код + наличие маркеров логина' },
            onChange: function () {
                Lampa.Noty.show('HDREZKA: проверяю сессию…');
                var ck = getCookie() || '';
                var domain = (Lampa.Storage.get(STORAGE.domain) || DEFAULT_DOMAIN).replace(/\/+$/, '');
                var url = domain + '/?t=' + Date.now();
                request({
                    url: url,
                    timeout: 15000,
                    success: function (html) {
                        var html_str = String(html || '');
                        var len = html_str.length;
                        var lower = html_str.toLowerCase();
                        var hasLogout = lower.indexOf('logout=yes') !== -1 || lower.indexOf('exituser') !== -1;
                        var hasLogin = lower.indexOf('<title>вход') !== -1 || lower.indexOf('login_name') !== -1;
                        var status = hasLogout ? '✓ авторизован' : (hasLogin ? '✗ страница входа (cookie не принят)' : '? непонятный ответ');
                        Lampa.Noty.show('HDREZKA: 200 OK, ' + len + ' байт, cookie=' + ck.length + ' — ' + status);
                    },
                    error: function (xhr, msg) {
                        var st = (xhr && xhr.status) || 0;
                        Lampa.Noty.show('HDREZKA: ошибка ' + st + ', cookie=' + ck.length + ' — ' + (msg || 'нет ответа'));
                    }
                });
            }
        });
    }

    /* ====================================================
     *  Bootstrap
     * ==================================================== */
    function registerManifest() {
        try {
            if (!Lampa.Manifest) Lampa.Manifest = {};
            // Старые билды: plugins — объект; новые: массив.
            if (Array.isArray(Lampa.Manifest.plugins)) {
                var already = Lampa.Manifest.plugins.some(function (p) {
                    return p && p.component === manifest.component;
                });
                if (!already) Lampa.Manifest.plugins.push(manifest);
            } else if (typeof Lampa.Manifest.plugins === 'object' && Lampa.Manifest.plugins) {
                Lampa.Manifest.plugins[manifest.component] = manifest;
            } else {
                // Поле отсутствует — создаём как объект (наиболее совместимый вариант)
                var box = {};
                box[manifest.component] = manifest;
                Lampa.Manifest.plugins = box;
            }
        } catch (err) {
            console.log('REZKA', 'manifest register failed', err && err.message);
        }
    }

    /* ====================================================
     *  v1.0.33: Глобальный listener изменения качества в плеере.
     *  ВАЖНО: событие 'quality' шлётся не в Lampa.Player.listener,
     *  а в Lampa.PlayerPanel.listener (это панель с кнопками «Качество»/«Дорожки»).
     *  Lampa.Player.listener знает только: create/ready/start/destroy/external.
     *  Поэтому подписываемся на ОБА источника.
     *  e = {name, url}, e.name — ярлык типа '1080p Ultra'/'720p'/'auto'.
     * ==================================================== */
    function registerGlobalQualityListener() {
        if (window._rezkaQualityListenerRegistered) return;
        try {
            // 1) Активность плеера — Lampa.Player.listener (start/destroy)
            if (Lampa.Player && Lampa.Player.listener && Lampa.Player.listener.follow) {
                Lampa.Player.listener.follow('start', function () {
                    window._rezkaPlayerActive = true;
                    console.log('REZKA', 'player active = true, filmId=' + (window._rezkaCurrentFilmId || ''));
                });
                Lampa.Player.listener.follow('destroy', function () {
                    window._rezkaPlayerActive = false;
                    console.log('REZKA', 'player active = false');
                });
            } else {
                console.log('REZKA', 'Player.listener unavailable');
            }

            var qualityHandler = function (e) {
                try {
                    if (!e || !e.name) return;
                    if (window._rezkaSelfWritingVQD) return; // игнорируем свои же записи
                    var label = String(e.name);
                    var fid = window._rezkaCurrentFilmId;
                    if (fid) {
                        try { Lampa.Storage.set('rezka_quality_' + fid, label); } catch (er) {}
                    }
                    try { Lampa.Storage.set('rezka_quality', label); } catch (er) {}
                    console.log('REZKA', 'quality event saved: "' + label + '" filmId=' + (fid || '-') + ' url=' + String(e.url || '').slice(-40));
                    // v1.0.34: уведомляем компонент — пусть перерисует фильтр «Качество» сразу.
                    try {
                        Lampa.Listener.send('rezka_quality', { type: 'changed', label: label, filmId: fid });
                    } catch (er) {}
                } catch (er) {
                    console.log('REZKA', 'quality handler error', er && er.message);
                }
            };

            // 2) ОСНОВНОЙ источник 'quality' — Lampa.PlayerPanel.listener
            var bound = false;
            if (Lampa.PlayerPanel && Lampa.PlayerPanel.listener && Lampa.PlayerPanel.listener.follow) {
                Lampa.PlayerPanel.listener.follow('quality', qualityHandler);
                bound = true;
                console.log('REZKA', 'v1.0.33 PlayerPanel.quality listener registered');
            }

            // 3) Дополнительно пытаемся и на Lampa.Player.listener — на случай форков, где quality прокидывают в Player.
            try {
                if (Lampa.Player && Lampa.Player.listener && Lampa.Player.listener.follow) {
                    Lampa.Player.listener.follow('quality', qualityHandler);
                }
            } catch (e2) {}

            if (!bound) {
                console.log('REZKA', 'WARNING: PlayerPanel.listener unavailable — quality save may not work');
            }
            window._rezkaQualityListenerRegistered = true;
        } catch (e) {
            console.log('REZKA', 'registerGlobalQualityListener error', e && e.message);
        }
    }

    /* ====================================================
     *  v1.0.40: Авто-перелог раз в RELOGIN_INTERVAL_MS (3 дня).
     *  Цель — держать cookie свежими, чтобы избежать 404 от rezka.fi
     *  когда сервер ротирует PHPSESSID/dle_hash.
     * ==================================================== */
    function maybeAutoRelogin() {
        try {
            var login = (Lampa.Storage.get(STORAGE.login) || '').trim();
            var pwd = (Lampa.Storage.get(STORAGE.password) || '').trim();
            if (!login || !pwd) {
                console.log('REZKA', 'auto-relogin: логин/пароль не заданы, пропускаю');
                return;
            }
            var ts = parseInt(Lampa.Storage.get(STORAGE.loginTs, 0), 10) || 0;
            var age = Date.now() - ts;
            if (ts && age < RELOGIN_INTERVAL_MS) {
                var hoursLeft = Math.round((RELOGIN_INTERVAL_MS - age) / 3600000);
                console.log('REZKA', 'auto-relogin: cookies свежие (возраст ' + Math.round(age/3600000) + 'ч, до обновления ' + hoursLeft + 'ч)');
                return;
            }
            console.log('REZKA', 'auto-relogin: возраст ' + Math.round(age/3600000) + 'ч ≥ 72ч, перелогиниваюсь…');
            authenticate(login, pwd, function (ok, msg) {
                console.log('REZKA', 'auto-relogin result:', ok ? 'OK' : 'FAIL', msg);
                if (Lampa.Noty && Lampa.Noty.show) {
                    Lampa.Noty.show('HDREZKA: авто-обновление сессии — ' + (ok ? '✓ ' : '✗ ') + msg);
                }
            });
        } catch (e) {
            console.log('REZKA', 'maybeAutoRelogin error:', e && e.message);
        }
    }

    function startPlugin() {
        if (window.rezka_plugin_started) return;
        window.rezka_plugin_started = true;
        try {
            ensureDefaults();
            registerManifest();
            registerPrestigeStyles();
            registerComponent();
            addSettings();
            addOnlineSource();
            addCardButton();
            registerGlobalQualityListener();
            // Авто-перелог: проверяем при старте и каждые 6 часов.
            setTimeout(maybeAutoRelogin, 5000);
            setInterval(maybeAutoRelogin, 6 * 60 * 60 * 1000);
            console.log('REZKA', 'plugin started OK');
        } catch (err) {
            console.log('REZKA', 'startPlugin error:', err && (err.stack || err.message));
            if (typeof Lampa !== 'undefined' && Lampa.Noty && Lampa.Noty.show) {
                Lampa.Noty.show('HDREZKA: ошибка старта — ' + (err && err.message));
            }
        }
    }

    function bootstrap() {
        if (typeof Lampa === 'undefined') {
            // Lampa ещё не загружена — ждём
            return setTimeout(bootstrap, 200);
        }
        if (window.appready) {
            startPlugin();
        } else if (Lampa.Listener && Lampa.Listener.follow) {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') startPlugin();
            });
            // Страховка: если событие уже прошло до нашей подписки — попробуем через секунду
            setTimeout(function () { if (window.appready) startPlugin(); }, 1000);
        } else {
            // Нет Listener — запускаем в лоб
            startPlugin();
        }
    }

    bootstrap();
})();
