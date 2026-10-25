/* Retro Rework Patcher — moteur commun et interface (prototype).
 *
 * Tout est traité dans le navigateur : la ROM du visiteur n'est jamais envoyée sur un serveur.
 * Dépendances (chargées avant ce fichier) :
 *   - RomPatcher.js v3.2.1 (MIT, Marc Robledo) : BinFile, HashCalculator, modules de formats, RomPatcher ;
 *   - rr-sha256.js (RRSha256) ; rr-i18n.js (RR_STRINGS, RR_LANGUAGES).
 *
 * Utilisation :
 *   RRPatcher.mount(element, { configUrl: 'games/super-r-type.json', baseUrl: '<racine du patcheur>/' });
 * ou index.html?game=super-r-type[&lang=fr|en]
 */
(function (global) {
	'use strict';

	/* ------------------------------------------------------------------ cœur (sans interface) */

	function rrError(code, params, detail) {
		const e = new Error(code);
		e.rrCode = code; e.rrParams = params || {}; e.rrDetail = detail || '';
		return e;
	}

	const RRCore = {
		/** Vrai si la valeur est une empreinte SHA-256 (64 caractères hexadécimaux). */
		isSha256(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v); },

		/**
		 * Vérifie les champs indispensables à une application sûre ; normalise les empreintes en minuscules.
		 * L'empreinte du résultat (output.sha256) est obligatoire : sans elle, aucun fichier n'est proposé.
		 * Retourne la liste des problèmes (vide si la configuration est utilisable).
		 */
		validateConfig(cfg) {
			const problems = [];
			if (!cfg || typeof cfg !== 'object') return ['configuration absente'];
			if (!cfg.output || typeof cfg.output !== 'object') problems.push('output manquant');
			else {
				if (!RRCore.isSha256(cfg.output.sha256)) problems.push('output.sha256 manquant ou invalide');
				else cfg.output.sha256 = cfg.output.sha256.toLowerCase();
				if (typeof cfg.output.fileName !== 'string' || !cfg.output.fileName.trim()) problems.push('output.fileName manquant');
			}
			if (!cfg.patch || typeof cfg.patch.url !== 'string' || !cfg.patch.url) problems.push('patch.url manquant');
			else if (RRCore.isSha256(cfg.patch.sha256)) cfg.patch.sha256 = cfg.patch.sha256.toLowerCase();
			(cfg.inputs || []).forEach(i => { if (RRCore.isSha256(i.sha256)) i.sha256 = i.sha256.toLowerCase(); });
			return problems;
		},

		/** Retire un en-tête de copieur (ex. 512 octets SNES) si la taille le trahit. */
		stripCopierHeader(bytes, headerSize) {
			if (headerSize && bytes.length > headerSize && bytes.length % 1024 === headerSize)
				return { bytes: bytes.slice(headerSize), removed: true };
			return { bytes: bytes, removed: false };
		},

		/** Identifie une ROM d'après son SHA-256 dans la configuration du jeu. */
		identify(cfg, sha) {
			if (cfg.output && cfg.output.sha256 === sha) return { kind: 'output' };
			const input = (cfg.inputs || []).find(i => i.sha256 === sha);
			return input ? { kind: 'input', input } : null;
		},

		/** Applique un patch (IPS, BPS, UPS…) avec RomPatcher.js, sans toucher aux octets reçus. */
		applyPatchBytes(romBytes, patchBytes) {
			const romBin = new BinFile(romBytes.slice().buffer);      // copie : la ROM source reste intacte
			const patchBin = new BinFile(patchBytes.slice().buffer);
			const patch = RomPatcher.parsePatchFile(patchBin);
			if (!patch) throw rrError('PATCH_FORMAT');
			if (!RomPatcher.validateRom(romBin, patch)) throw rrError('PATCH_SOURCE_MISMATCH');
			const out = RomPatcher.applyPatch(romBin, patch, { requireValidation: true, outputSuffix: false });
			const u8 = out._u8array;
			return new Uint8Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + out.fileSize));
		},

		/** Télécharge le patch officiel et vérifie son empreinte. */
		async loadOfficialPatch(cfg, baseUrl) {
			let res;
			try { res = await fetch(new URL(cfg.patch.url, baseUrl), { cache: 'no-cache' }); }
			catch (e) { throw rrError('PATCH_DOWNLOAD', {}, String(e)); }
			if (!res.ok) throw rrError('PATCH_DOWNLOAD', {}, 'HTTP ' + res.status);
			const bytes = new Uint8Array(await res.arrayBuffer());
			const sha = await RRSha256.sha256(bytes);
			if (cfg.patch.sha256 && sha !== cfg.patch.sha256) throw rrError('PATCH_INTEGRITY', {}, 'SHA-256 ' + sha);
			return bytes;
		}
	};

	/* ------------------------------------------------------------------ interface */

	const STEP_SELECT = 'select', STEP_PREREQ = 'prereq', STEP_READY = 'ready', STEP_DONE = 'done';

	function pickLanguage() {
		const fromUrl = new URLSearchParams(location.search).get('lang');
		if (fromUrl && RR_LANGUAGES.includes(fromUrl)) return fromUrl;
		try { const s = localStorage.getItem('rr-patcher-lang'); if (s && RR_LANGUAGES.includes(s)) return s; } catch (e) { /* stockage indisponible */ }
		const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
		return RR_LANGUAGES.includes(nav) ? nav : RR_LANGUAGES[RR_LANGUAGES.length - 1];
	}

	function formatSize(n) {
		return n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(0) + ' Ko' : (n / 1048576).toFixed(2) + ' Mo';
	}

	function el(tag, attrs, children) {
		const node = document.createElement(tag);
		for (const k in (attrs || {})) {
			if (k === 'text') node.textContent = attrs[k];
			else if (k === 'onclick' || k === 'onchange') node[k] = attrs[k];
			else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k]);
		}
		(children || []).forEach(c => c && node.appendChild(c));
		return node;
	}

	let instances = 0;

	class Patcher {
		constructor(root, cfg, baseUrl) {
			this.root = root; this.cfg = cfg; this.baseUrl = baseUrl;
			this.uid = 'rrp' + (++instances);   // identifiants HTML uniques (plusieurs patcheurs par page)
			this.lang = pickLanguage();
			this.configProblems = RRCore.validateConfig(cfg);
			this.reset();
		}

		/** Refuse toute opération si la configuration ne garantit pas la vérification du résultat. */
		assertConfig() {
			if (this.configProblems.length) throw rrError('CONFIG_INVALID', {}, this.configProblems.join(' ; '));
		}

		t(key, params) {
			const dict = RR_STRINGS[this.lang] || RR_STRINGS.en;
			let s = dict[key] != null ? dict[key] : (RR_STRINGS.en[key] || key);
			const all = Object.assign({ game: this.cfg.game, version: this.cfg.version, extensions: (this.cfg.extensions || []).join(', ') }, params || {});
			return s.replace(/\{(\w+)\}/g, (m, k) => all[k] != null ? all[k] : m);
		}
		local(obj) { return obj ? (obj[this.lang] || obj.en || obj.fr || '') : ''; }

		reset() {
			if (this.outputUrl) URL.revokeObjectURL(this.outputUrl);
			this.state = { step: STEP_SELECT, busy: false, notes: [], error: null, info: null, input: null, prereqIndex: 0, tech: [] };
			this.romBytes = null; this.romSha = null; this.workBytes = null; this.output = null; this.outputUrl = null;
			if (this.configProblems.length) { this.fail(rrError('CONFIG_INVALID', {}, this.configProblems.join(' ; '))); return; }
			this.render();
		}

		fail(err) {
			const code = err && err.rrCode;
			const map = {
				UNKNOWN_ROM: ['errUnknown', 'errUnknownHelp'], NOT_ROM: ['errNotRom'], TOO_BIG: ['errTooBig'],
				PREREQ_WRONG: ['errPrereqWrong'], PATCH_DOWNLOAD: ['errPatchDownload'], PATCH_INTEGRITY: ['errPatchIntegrity'],
				RESULT_MISMATCH: ['errResult'], SOURCE_ALTERED: ['errResult'], BROWSER: ['errBrowser'],
				CONFIG_INVALID: ['errConfig']
			};
			const keys = map[code] || ['errGeneric'];
			this.state.error = { keys, params: (err && err.rrParams) || {}, detail: (err && (err.rrDetail || (!code && err.message))) || '' };
			this.state.busy = false;
			if (!code && global.console) console.error(err);
			this.render();
		}

		async readFile(file) {
			if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
			if (typeof FileReader !== 'function') throw rrError('BROWSER');
			return new Uint8Array(await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsArrayBuffer(file); }));
		}

		async onRomSelected(file) {
			if (!file) return;
			this.reset();
			if (this.configProblems.length) return;   // déjà signalé par reset()
			this.state.busy = true; this.state.fileName = file.name; this.render();
			try {
				if (file.size > (this.cfg.maxRomSize || 67108864)) throw rrError('TOO_BIG');
				if (file.size < 0x8000) throw rrError('NOT_ROM', { size: formatSize(file.size) });
				const raw = await this.readFile(file);
				const { bytes, removed } = RRCore.stripCopierHeader(raw, this.cfg.copierHeader);
				const sha = await RRSha256.sha256(bytes);
				this.state.tech.push(['ROM', `${file.name} — ${formatSize(raw.length)}`], ['SHA-256', sha]);
				const id = RRCore.identify(this.cfg, sha);
				if (!id) throw rrError('UNKNOWN_ROM', { expected: this.local(this.cfg.expectedText) || this.cfg.game });
				if (id.kind === 'output') { this.state.busy = false; this.state.info = 'errAlreadyPatched'; this.render(); return; }
				this.romBytes = bytes; this.romSha = sha; this.workBytes = bytes;
				this.state.input = id.input;
				this.state.notes.push(['romOk', { labelOf: id.input }]);
				if (removed) this.state.notes.push(['headerRemoved']);
				this.state.prereqIndex = 0;
				this.state.step = (id.input.prerequisites || []).length ? STEP_PREREQ : STEP_READY;
				this.state.busy = false;
				this.render();
			} catch (e) { this.fail(e); }
		}

		currentPrereq() { return (this.state.input.prerequisites || [])[this.state.prereqIndex]; }

		async onPrereqSelected(file) {
			const pre = this.currentPrereq();
			if (!file || !pre) return;
			this.state.error = null; this.state.busy = true; this.render();
			try {
				const patchBytes = await this.readFile(file);
				let result;
				try { result = RRCore.applyPatchBytes(this.workBytes, patchBytes); }
				catch (e) { throw rrError('PREREQ_WRONG', { name: pre.name }, e.rrCode || e.message); }
				const sha = await RRSha256.sha256(result);
				if (pre.resultSha256 && sha !== pre.resultSha256) throw rrError('PREREQ_WRONG', { name: pre.name }, 'SHA-256 ' + sha);
				this.workBytes = result;
				this.state.tech.push([pre.name, 'SHA-256 ' + sha]);
				this.state.notes.push(['prereqOk', { name: pre.name }]);
				this.state.prereqIndex++;
				if (!this.currentPrereq()) this.state.step = STEP_READY;
				this.state.busy = false;
				this.render();
			} catch (e) { this.fail(e); }
		}

		async onApply() {
			this.state.error = null; this.state.busy = true; this.render();
			try {
				this.assertConfig();
				const patchBytes = await RRCore.loadOfficialPatch(this.cfg, this.baseUrl);
				let result;
				try { result = RRCore.applyPatchBytes(this.workBytes, patchBytes); }
				catch (e) { throw rrError('RESULT_MISMATCH', {}, e.rrCode || e.message); }
				const sha = await RRSha256.sha256(result);
				this.state.tech.push(['Retro Rework', 'SHA-256 ' + sha]);
				this.assertConfig();   // empreinte de sortie obligatoire : jamais de téléchargement sans comparaison
				if (sha !== this.cfg.output.sha256) throw rrError('RESULT_MISMATCH', {}, 'SHA-256 ' + sha);
				if (await RRSha256.sha256(this.romBytes) !== this.romSha) throw rrError('SOURCE_ALTERED');
				this.output = result;
				this.outputUrl = URL.createObjectURL(new Blob([result], { type: 'application/octet-stream' }));
				this.state.step = STEP_DONE; this.state.busy = false;
				this.state.notes.push(['patchOk']);
				this.render();
			} catch (e) { this.fail(e); }
		}

		setLang(lang) {
			this.lang = lang;
			try { localStorage.setItem('rr-patcher-lang', lang); } catch (e) { /* stockage indisponible */ }
			this.render();
		}

		/* ---------------- rendu ---------------- */
		render() {
			const s = this.state, cfg = this.cfg, step = s.step;
			const stepIndex = { [STEP_SELECT]: 1, [STEP_PREREQ]: 2, [STEP_READY]: 2, [STEP_DONE]: 3 }[step];
			const box = el('div', { class: 'rrp' });

			// en-tête : titre + langues
			const langs = el('div', { class: 'rrp-langs', role: 'group', 'aria-label': this.t('langLabel') },
				RR_LANGUAGES.map(l => el('button', { type: 'button', class: 'rrp-lang' + (l === this.lang ? ' is-active' : ''), 'aria-pressed': l === this.lang ? 'true' : 'false', text: l.toUpperCase(), onclick: () => this.setLang(l) })));
			box.appendChild(el('div', { class: 'rrp-head' }, [el('h2', { class: 'rrp-title', text: this.t('title') }), langs]));
			box.appendChild(el('p', { class: 'rrp-intro', text: this.t('intro') }));
			box.appendChild(el('p', { class: 'rrp-privacy', text: '🔒 ' + this.t('privacy') }));

			const card = (n, titleKey, content) => el('section', { class: 'rrp-step' + (n === stepIndex ? ' is-current' : '') + (n < stepIndex ? ' is-done' : '') }, [
				el('div', { class: 'rrp-step-head' }, [el('span', { class: 'rrp-num', text: n < stepIndex ? '✓' : String(n) }), el('h3', { text: this.t(titleKey) })]),
				el('div', { class: 'rrp-step-body' }, content)
			]);

			// Étape 1
			const romInput = el('input', { type: 'file', id: this.uid + '-rom', 'data-role': 'rom', class: 'rrp-file', accept: (cfg.extensions || []).join(','), disabled: this.configProblems.length ? 'disabled' : false });
			romInput.onchange = () => this.onRomSelected(romInput.files[0]);
			box.appendChild(card(1, 'step1', [
				el('p', { class: 'rrp-help', text: this.t('step1Help') }),
				el('label', { for: this.uid + '-rom', class: 'rrp-btn' + (step === STEP_SELECT && !this.configProblems.length ? ' rrp-btn-primary' : ' rrp-btn-ghost'), 'aria-disabled': this.configProblems.length ? 'true' : false, style: this.configProblems.length ? 'opacity:.5;cursor:not-allowed' : false }, [el('span', { text: s.fileName ? s.fileName : this.t('chooseRom') })]),
				romInput
			]));

			// Étape 2
			const body2 = [];
			if (step === STEP_SELECT) body2.push(el('p', { class: 'rrp-muted', text: s.busy ? this.t('checking') : this.t('waitingRom') }));
			s.notes.forEach(([k, p]) => body2.push(el('p', { class: 'rrp-ok', text: this.t(k, p && p.labelOf ? { label: this.local(p.labelOf.label) } : p) })));
			if (step === STEP_PREREQ) {
				const pre = this.currentPrereq();
				const preInput = el('input', { type: 'file', id: this.uid + '-pre', 'data-role': 'prereq', class: 'rrp-file', accept: (pre.accept || []).join(',') });
				preInput.onchange = () => this.onPrereqSelected(preInput.files[0]);
				body2.push(el('div', { class: 'rrp-prereq' }, [
					el('p', { class: 'rrp-strong', text: this.t('needsPrereq', { name: pre.name, author: pre.author }) }),
					el('p', { class: 'rrp-help', text: this.t('prereqHelp') }),
					el('p', {}, [el('a', { href: pre.url, target: '_blank', rel: 'noopener noreferrer', class: 'rrp-link', text: this.t('prereqLink', { name: pre.name }) + ' ↗' })]),
					el('label', { for: this.uid + '-pre', class: 'rrp-btn rrp-btn-primary' }, [el('span', { text: this.t('choosePrereq', { name: pre.name }) })]),
					preInput
				]));
			}
			if (step === STEP_READY)
				body2.push(el('button', { type: 'button', class: 'rrp-btn rrp-btn-primary', disabled: s.busy ? 'disabled' : false, onclick: () => this.onApply(), text: s.busy ? this.t('applying') : this.t('apply') }));
			box.appendChild(card(2, 'step2', body2));

			// Étape 3
			const body3 = [];
			if (step === STEP_DONE) {
				body3.push(el('a', { class: 'rrp-btn rrp-btn-primary rrp-download', href: this.outputUrl, download: cfg.output.fileName, text: '⬇ ' + this.t('download', { file: cfg.output.fileName }) }));
				body3.push(el('p', { class: 'rrp-help', text: this.t('downloadHelp') }));
			}
			box.appendChild(card(3, 'step3', body3));

			// Messages
			if (s.info) box.appendChild(el('div', { class: 'rrp-alert rrp-alert-info', role: 'status' }, [el('p', { text: this.t(s.info) })]));
			if (s.error) box.appendChild(el('div', { class: 'rrp-alert rrp-alert-error', role: 'alert' }, s.error.keys.map(k => el('p', { text: this.t(k, Object.assign({ detail: s.error.detail }, s.error.params)) }))));
			if (!this.configProblems.length && (step !== STEP_SELECT || s.error || s.info))
				box.appendChild(el('button', { type: 'button', class: 'rrp-btn rrp-btn-ghost rrp-restart', onclick: () => this.reset(), text: this.t('restart') }));

			// Détails techniques (repliés)
			if (s.tech.length || (s.error && s.error.detail)) {
				const rows = s.tech.map(([k, v]) => el('div', { class: 'rrp-tech-row' }, [el('span', { text: k }), el('code', { text: v })]));
				if (s.error && s.error.detail) rows.push(el('div', { class: 'rrp-tech-row' }, [el('span', { text: 'Info' }), el('code', { text: s.error.detail })]));
				box.appendChild(el('details', { class: 'rrp-tech' }, [el('summary', { text: this.t('details') })].concat(rows)));
			}
			if (cfg.links && cfg.links.credits)
				box.appendChild(el('p', { class: 'rrp-foot' }, [el('a', { href: cfg.links.credits, target: '_blank', rel: 'noopener noreferrer', text: this.t('credits') + ' ↗' })]));

			this.root.replaceChildren(box);
			this.root.setAttribute('lang', this.lang);
			postHeight();
		}
	}

	/* Hauteur transmise à la page parente quand le patcheur est dans une iframe. */
	function postHeight() {
		if (global.parent && global.parent !== global) {
			const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
			global.parent.postMessage({ type: 'rr-patcher:height', height: h }, '*');
		}
	}
	if (typeof ResizeObserver === 'function') new ResizeObserver(postHeight).observe(document.documentElement);

	async function mount(root, options) {
		const opts = options || {};
		const baseUrl = opts.baseUrl || document.baseURI;
		try {
			if (typeof Uint8Array !== 'function' || typeof fetch !== 'function') throw rrError('BROWSER');
			const res = await fetch(new URL(opts.configUrl, baseUrl), { cache: 'no-cache' });
			if (!res.ok) throw new Error('config HTTP ' + res.status);
			const cfg = await res.json();
			const p = new Patcher(root, cfg, baseUrl);
			root.rrPatcher = p;
			return p;
		} catch (e) {
			root.textContent = 'Retro Rework Patcher : configuration introuvable / configuration not found.';
			throw e;
		}
	}

	/* Démarrage automatique : <div id="rr-patcher"></div> + ?game=<id> ou data-game="<id>" */
	function autoStart() {
		const root = document.getElementById('rr-patcher');
		if (!root) return;
		const theme = new URLSearchParams(location.search).get('theme');   // ?theme=light|dark (sinon : réglage du système)
		if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
		const game = root.getAttribute('data-game') || new URLSearchParams(location.search).get('game') || '';
		if (!/^[a-z0-9-]+$/.test(game)) { root.textContent = 'Retro Rework Patcher : ?game=<id> manquant / missing.'; return; }
		mount(root, { configUrl: 'games/' + game + '.json', baseUrl: root.getAttribute('data-base') || document.baseURI });
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart); else autoStart();

	global.RRCore = RRCore;
	global.RRPatcher = { mount };
})(window);
