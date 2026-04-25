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
        version: '1.0.12',
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
        cookie:   'rezka_cookie',     // dle_user_id=...; dle_password=...
        status:   'rezka_status',     // 'logged' | 'guest' | 'error:<msg>'
        proxy:    'rezka_proxy_url'   // optional CORS proxy
    };

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
        if (ck) headers['Cookie'] = ck;
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

        function callSilent() {
            network.silent(opts.url, success, function (a, b) { error(a, b); },
                opts.post || false,
                { dataType: opts.dataType || 'text', headers: safeHeaders });
        }

        // 1) Предпочтительно — native (Android APK)
        try {
            if (typeof network["native"] === 'function' &&
                Lampa.Platform && Lampa.Platform.is && Lampa.Platform.is('android')) {
                network["native"](opts.url, success, function (a, b) {
                    // fallback на silent в случае ошибки native-стека
                    console.log('REZKA', 'native fail, falling back to silent', a, b);
                    callSilent();
                }, opts.post || false, params);
                return network;
            }
        } catch (e) { /* fall through to silent */ }

        // 2) silent для веб/iOS/Tizen — без запрещённых заголовков
        callSilent();
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
                // 1) пробуем достать cookies из document.cookie (на веб-Lampa может работать)
                var cookieStr = '';
                try { cookieStr = document.cookie || ''; } catch (e) {}
                var dle = cookieStr.split(';').map(function (s) { return s.trim(); })
                    .filter(function (s) { return /^dle_(user_id|password|hash|forum_sessions)=/.test(s); })
                    .join('; ');
                if (dle) Lampa.Storage.set(STORAGE.cookie, dle);
                Lampa.Storage.set(STORAGE.status, 'logged');
                console.log('REZKA', 'login OK; document.cookie dle=', dle ? 'YES' : 'NO');

                // 2) Verification test: на Android cookies хранятся в OkHttp CookieJar.
                // Чтобы убедиться что сессия применяется к последующим запросам —
                // дёрнем главную и проверим, виден ли залогиненный пользователь.
                verifySession(function (verified, hint) {
                    if (verified) {
                        console.log('REZKA', 'session verified via', hint);
                        done(true, 'Вход успешен. Сессия активна (' + hint + ')');
                    } else {
                        console.log('REZKA', 'session verify FAILED:', hint);
                        // Логин-ответ был ОК, но сервер всё равно отдаёт страницу логина —
                        // значит cookies не доходят до native-стека.
                        Lampa.Storage.set(STORAGE.status, 'logged'); // оставим logged — пробуем
                        done(true,
                            'Вход OK, но сессия не пробрасывается в Lampa-Android. ' +
                            'Используйте "Cookie (ручной вход)" — скопируйте dle_user_id и dle_password из браузера');
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
            // shortcut: если у нас уже есть Storage.cookie — считаем верифицированным
            if (getCookie()) return cb(true, 'document.cookie');

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
    }

    /* ====================================================
     *  Search on HDREZKA
     *  GET /engine/ajax/search.php?q=<title>
     * ==================================================== */
    function searchRezka(query, year, cb) {
        var url = proxify(getDomain() + '/engine/ajax/search.php?q=' + encodeURIComponent(query));
        console.log('REZKA', 'search start: query=', query, 'year=', year, 'url=', url);
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
                // Год — из любого вхождения (4 цифры 19xx/20xx)
                var ym = fullText.match(/\b(19|20)\d{2}\b/);
                items.push({
                    url: href,
                    title: title,
                    year: ym ? ym[0] : ''
                });
            });
            // если знаем год — предпочитаем точное совпадение
            if (year) {
                var exact = items.filter(function (i) { return i.year == String(year); });
                if (exact.length) items = exact;
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

            // film id
            var idm = str.match(/initCDN(?:Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([01])\s*,\s*([01])\s*(?:,\s*([01]))?/);
            if (idm) {
                info.film_id = idm[1];
                var defVoiceId = idm[2];
                info.is_series = /initCDNSeriesEvents/.test(str);
                var camrip = idm[3], ads = idm[4], director = idm[5] || '0';

                // favs hash
                var fm = str.match(/var\s+sof\s*=.*?\.send\([^,]+,\s*'([^']+)'/);
                if (!fm) fm = str.match(/data-favs="([^"]+)"/);
                if (fm) info.favs = fm[1];

                // translators block
                var tm = str.match(/<ul[^>]+class="b-translator__list"[\s\S]*?<\/ul>/);
                if (tm) {
                    var d = document.createElement('div');
                    d.innerHTML = tm[0];
                    d.querySelectorAll('.b-translator__item').forEach(function (li) {
                        info.voice.push({
                            name: (li.getAttribute('title') || li.textContent || '').trim(),
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
                                    var oc = a.getAttribute('onclick') || a.getAttribute('data-onclick') || '';
                                    var im = oc.match(/(\d{3,})/);
                                    if (im) id = im[1];
                                }
                                info.voice.push({
                                    name: name,
                                    id: id || defVoiceId,
                                    is_camrip: camrip, is_ads: ads, is_director: director
                                });
                            });
                        }
                        // 2) fallback — разобрать текстом через запятую
                        if (!info.voice.length) {
                            var raw = (dd.textContent || '').trim();
                            raw.split(/,\s*/).forEach(function (n) {
                                n = n.trim().replace(/\s*\(\+субтитры\)\s*$/i, '');
                                if (n) info.voice.push({
                                    name: n, id: defVoiceId,
                                    is_camrip: camrip, is_ads: ads, is_director: director
                                });
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
                    var sm = str.match(/<ul[^>]+class="b-simple_seasons__list"[\s\S]*?<\/ul>/);
                    if (sm) {
                        var ds = document.createElement('div'); ds.innerHTML = sm[0];
                        ds.querySelectorAll('.b-simple_season__item').forEach(function (li) {
                            info.season.push({
                                name: (li.textContent || '').trim(),
                                id: li.getAttribute('data-tab_id')
                            });
                        });
                    }
                    var em = str.match(/<ul[^>]+class="b-simple_episodes__list"[\s\S]*?<\/ul>/g);
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
        var post;
        if (info.is_series && season && episode) {
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

        try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.setRequestHeader('Referer', getDomain() + '/');
            xhr.withCredentials = true;
            xhr.timeout = 15000;
            xhr.onload = function () {
                try {
                    var json = JSON.parse(xhr.responseText);
                    if (!json.success) { err && err(json.message || 'Сервер вернул ошибку'); return; }
                    var decoded = decodeTrash(json.url);
                    var items = parsePlaylist(decoded);
                    if (!items.length) { err && err('Пустой плейлист'); return; }
                    var qualities = {};
                    items.forEach(function (it) { qualities[it.label] = it.file; });
                    if (json.premium_content) {
                        // premium URLs are dummies for free accounts
                        // but we still try to play in case the user has premium
                    }
                    cb({
                        title: '',
                        file: items[items.length - 1].file, // best (last)
                        quality: qualities,
                        subtitles: parseSubtitles(json.subtitle)
                    });
                } catch (e) { err && err('Не удалось разобрать ответ'); }
            };
            xhr.onerror = function () { err && err('Сетевая ошибка'); };
            xhr.ontimeout = function () { err && err('Таймаут'); };
            xhr.send(post);
        } catch (e) { err && err(e.message); }
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
            scroll.minus();
            files.appendFiles(scroll.render());
            files.appendHead(filter.render());

            filter.onSearch = function (value) {
                Lampa.Activity.replace({ search: value, clarification: true });
            };
            filter.onBack = function () { self.start(); };

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
                right: function () { Navigator.move('right'); },
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

        function playVoice(info, voice, season, episode) {
            Lampa.Modal.open({
                title: 'HDREZKA',
                html: $('<div style="padding:1em">Получаем ссылку (' + escapeHTML(voice.name) + ')…</div>'),
                size: 'small',
                onBack: function () { Lampa.Modal.close(); Lampa.Controller.toggle('content'); }
            });
            getStream(info, voice, season, episode,
                function (data) {
                    Lampa.Modal.close();
                    var pl = {
                        url: data.file,
                        title: (object.movie.title || object.movie.name || '') + ' — ' + voice.name,
                        quality: data.quality,
                        subtitles: data.subtitles
                    };
                    Lampa.Player.play(pl);
                    Lampa.Player.playlist([pl]);
                },
                function (msg) {
                    Lampa.Modal.close();
                    Lampa.Noty.show('HDREZKA: ' + msg);
                });
        }

        function buildList() {
            html.empty();
            if (!state.info) return;
            var info = state.info;

            // Для сериала — выбранная озвучка + список серий
            // Для фильма   — список всех озвучек (каждая = своя карточка)
            if (info.is_series) {
                var voice = info.voice[state.choice.voice] || info.voice[0];
                var season = info.season[state.choice.season];
                var items = season ? info.episode.filter(function (e) {
                    return String(e.season_id) === String(season.id);
                }) : [];
                items.forEach(function (ep) {
                    var item = $('<div class="online selector"><div class="online__title">' +
                        escapeHTML(ep.name) + '</div><div class="online__quality">' +
                        escapeHTML(voice.name) + '</div></div>');
                    item.on('hover:enter', function () {
                        playVoice(info, voice, season, ep);
                    });
                    html.append(item);
                });
            } else {
                // Фильм — одна карточка на каждую озвучку
                info.voice.forEach(function (voice, idx) {
                    var item = $('<div class="online selector"><div class="online__title">' +
                        escapeHTML(voice.name) +
                        '</div><div class="online__quality">Фильм — нажмите OK</div></div>');
                    item.on('hover:enter', function () {
                        state.choice.voice = idx;
                        playVoice(info, voice, null, null);
                    });
                    html.append(item);
                });
                if (!info.voice.length) {
                    html.append('<div class="online__nothing" style="padding:1em;color:#ccc">Нет доступных озвучек</div>');
                }
            }
            scroll.append(html);
            Lampa.Controller.enable('content');
        }

        function buildFilter() {
            if (!state.info) return;
            var info = state.info;
            // Для фильма фильтр по озвучке не нужен — они все в списке ниже.
            var rows = [];
            if (info.is_series) {
                var vName = (info.voice[state.choice.voice] || info.voice[0] || {}).name || '—';
                rows.push({ title: 'Перевод', subtitle: vName, stype: 'voice' });
                if (info.season.length) {
                    var sName = (info.season[state.choice.season] || {}).name || '—';
                    rows.push({ title: 'Сезон', subtitle: sName, stype: 'season' });
                }
            }
            try { filter.set('filter', rows); } catch (e) {}
            try { filter.set('sort', []); } catch (e) {}
            filter.onSelect = function (type, a, b) {
                if (a.stype === 'voice') {
                    var names = info.voice.map(function (v) { return v.name; });
                    Lampa.Select.show({
                        title: 'Перевод',
                        items: names.map(function (n, i) { return { title: n, index: i }; }),
                        onBack: function () { Lampa.Controller.toggle('content'); },
                        onSelect: function (s) {
                            state.choice.voice = s.index;
                            buildFilter();
                            buildList();
                            Lampa.Controller.toggle('content');
                        }
                    });
                } else if (a.stype === 'season') {
                    Lampa.Select.show({
                        title: 'Сезон',
                        items: info.season.map(function (s, i) { return { title: s.name, index: i }; }),
                        onBack: function () { Lampa.Controller.toggle('content'); },
                        onSelect: function (s) {
                            state.choice.season = s.index;
                            buildFilter();
                            buildList();
                            Lampa.Controller.toggle('content');
                        }
                    });
                }
            };
        }

        this.initialize = function () {
            this.activity.loader(true);

            var movie = object.movie || {};
            var title = movie.title || movie.name || '';
            var year = (movie.release_date || movie.first_air_date || '').slice(0, 4);
            console.log('REZKA', 'component initialize. movie.title=', title, 'year=', year, 'domain=', getDomain(), 'logged=', isLoggedIn());

            searchRezka(title, year, function (results) {
                if (!results.length) {
                    self.activity.loader(false);
                    showError('Ничего не найдено на HDREZKA');
                    self.activity.toggle();
                    return;
                }
                fetchFilmPage(results[0].url, function (info) {
                    state.info = info;
                    self.activity.loader(false);
                    buildFilter();
                    buildList();
                    self.activity.toggle();
                }, function (xhr, msg) {
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
                });
            });
        };
    }

    /* ====================================================
     *  Register component & online source button
     * ==================================================== */
    function registerComponent() {
        if (Lampa.Component && Lampa.Component.add) {
            Lampa.Component.add('rezka_online', component);
        }
    }

    function openRezka(movie) {
        Lampa.Activity.push({
            url: '',
            title: 'HDREZKA - ' + (movie.title || movie.name || ''),
            component: 'rezka_online',
            movie: movie,
            page: 1
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
        if (s === 'logged') return '🟢 Вы вошли в аккаунт';
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

        // ── ОСНОВНОЙ путь: вход по Cookie ───────────────────────────
        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.cookie, type: 'input', values: '', default: '' },
            field: {
                name: '🔑 Cookie из браузера (РЕКОМЕНДУЕТСЯ)',
                description: 'Вставьте: dle_user_id=12345; dle_password=abcd... (см. инструкцию ниже)'
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

        // ── Резервный путь: автологин (часто не работает на Android) ──
        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.login, type: 'input', values: '', default: '' },
            field: { name: 'Логин / E-mail (резервный путь)', description: 'Email или имя пользователя HDREZKA' }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: STORAGE.password, type: 'input', values: '', default: '' },
            field: { name: 'Пароль', description: 'Хранится локально на устройстве' }
        });

        Lampa.SettingsApi.addParam({
            component: 'rezka',
            param: { name: 'rezka_login_button', type: 'trigger' },
            field: { name: 'Войти автоматически', description: 'На Lampa-Android часто не работает — используйте Cookie выше' },
            onChange: function () {
                var login = Lampa.Storage.get(STORAGE.login);
                var pwd   = Lampa.Storage.get(STORAGE.password);
                if (!login || !pwd) {
                    Lampa.Noty.show('Введите логин и пароль');
                    return;
                }
                Lampa.Noty.show('Авторизация на HDREZKA…');
                authenticate(login, pwd, function (ok, msg) {
                    Lampa.Noty.show((ok ? '✓ ' : '✗ ') + msg);
                    $('[data-name="rezka_status_view"] .settings-param__descr').text(statusLabel());
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

    function startPlugin() {
        if (window.rezka_plugin_started) return;
        window.rezka_plugin_started = true;
        try {
            ensureDefaults();
            registerManifest();
            registerComponent();
            addSettings();
            addOnlineSource();
            addCardButton();
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
