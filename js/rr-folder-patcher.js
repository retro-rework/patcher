/* Retro Rework Patcher — mode « dossier » (jeux PC / arcade en plusieurs fichiers, ex. SEGA Rally 3).
 *
 * Tout est traité dans le navigateur : aucun fichier du visiteur n'est envoyé sur Internet.
 * Le visiteur choisit le dossier de son jeu ; chaque fichier utile est vérifié (SHA-256), puis le patcheur
 * produit une archive ZIP (sans compression) des seuls fichiers modifiés, à extraire dans le dossier du jeu.
 * Les gros fichiers ne sont jamais chargés en entier : lecture par tranches, et l'archive est composée de
 * références (Blob) vers les fichiers d'origine du visiteur.
 *
 * Opérations (games/<id>.json, "mode": "folder") :
 *   bps    { path, source{size,sha256}, patch{url,size,sha256}, target{size,sha256} }  patch BPS (RomPatcher.js)
 *   append { path, source, patch, target }   cible = fichier d'origine + queue téléchargée
 *   copy   { path, from, target }            copie d'un fichier d'origine du visiteur (jamais distribué)
 *   ini    { path, section, set{clé:valeur}, optional }  réglages posés clé par clé, le reste est conservé
 *   mkdir  { path }                          dossier à créer (entrée de dossier dans le ZIP)
 * Dépendances : RomPatcher.js (BinFile, HashCalculator, format BPS, RomPatcher). Aucune autre.
 * Utilisation : <div id="rr-patcher" data-mode="folder" data-game="sega-rally-3"></div>  (ou ?game=<id>)
 * (l'identifiant rr-patcher reprend la feuille css/patcher.css et la traduction de js/rr-page.js, inchangées)
 */
(function (global) {
	'use strict';

	/* ------------------------------------------------------------------ SHA-256 incrémental (FIPS 180-4) */
	const K = new Int32Array([
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

	class Sha256 {
		constructor(src) {
			this.h = src ? src.h.slice() : new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
			this.buf = src ? src.buf.slice() : new Uint8Array(64);
			this.bufLen = src ? src.bufLen : 0; this.len = src ? src.len : 0; this.w = new Int32Array(64);
		}
		clone() { return new Sha256(this); }
		block(d, o) {
			const w = this.w, h = this.h;
			for (let i = 0; i < 16; i++, o += 4) w[i] = (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3];
			for (let i = 16; i < 64; i++) {
				const a = w[i - 15], b = w[i - 2];
				w[i] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + w[i - 7] +
					(((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + w[i - 16] | 0;
			}
			let A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
			for (let i = 0; i < 64; i++) {
				const t1 = H + (((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7))) + ((E & F) ^ (~E & G)) + K[i] + w[i] | 0;
				const t2 = (((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10))) + ((A & B) ^ (A & C) ^ (B & C)) | 0;
				H = G; G = F; F = E; E = D + t1 | 0; D = C; C = B; B = A; A = t1 + t2 | 0;
			}
			h[0] += A; h[1] += B; h[2] += C; h[3] += D; h[4] += E; h[5] += F; h[6] += G; h[7] += H;
		}
		update(d) {
			let i = 0; const n = d.length; this.len += n;
			if (this.bufLen) {
				const k = Math.min(64 - this.bufLen, n); this.buf.set(d.subarray(0, k), this.bufLen); this.bufLen += k; i = k;
				if (this.bufLen < 64) return this;
				this.block(this.buf, 0); this.bufLen = 0;
			}
			for (; i + 64 <= n; i += 64) this.block(d, i);
			if (i < n) { this.buf.set(d.subarray(i), 0); this.bufLen = n - i; }
			return this;
		}
		hex() {
			const s = this.clone(), bits = s.len * 8, pad = new Uint8Array(((s.bufLen < 56 ? 56 : 120) - s.bufLen) + 8);
			pad[0] = 0x80;
			const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0, e = pad.length;
			pad[e - 8] = hi >>> 24; pad[e - 7] = hi >>> 16; pad[e - 6] = hi >>> 8; pad[e - 5] = hi;
			pad[e - 4] = lo >>> 24; pad[e - 3] = lo >>> 16; pad[e - 2] = lo >>> 8; pad[e - 1] = lo;
			s.update(pad);
			return Array.from(s.h, v => (v >>> 0).toString(16).padStart(8, '0')).join('');
		}
	}

	/* ------------------------------------------------------------------ CRC-32 (ZIP) */
	const CRC_T = new Int32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
	class Crc32 {
		constructor(src) { this.c = src ? src.c : -1; }
		clone() { return new Crc32(this); }
		update(d) { let c = this.c; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 0xff] ^ (c >>> 8); this.c = c; return this; }
		value() { return (this.c ^ -1) >>> 0; }
	}

	/* ------------------------------------------------------------------ lecture par tranches */
	const CHUNK = 16 * 1024 * 1024;
	async function readBlob(blob) { return new Uint8Array(await blob.arrayBuffer()); }
	/** Parcourt un fichier par tranches : SHA-256 + CRC-32 ; garde les octets si keep. */
	async function scan(file, keep, onProgress) {
		const sha = new Sha256(), crc = new Crc32();
		if (keep) { const b = await readBlob(file); sha.update(b); crc.update(b); return { sha, crc, bytes: b }; }
		for (let off = 0; off < file.size; off += CHUNK) {
			const b = await readBlob(file.slice(off, Math.min(off + CHUNK, file.size)));
			sha.update(b); crc.update(b);
			if (onProgress) onProgress(Math.min(off + CHUNK, file.size) / file.size);
		}
		return { sha, crc, bytes: null };
	}
	const KEEP_LIMIT = 64 * 1024 * 1024;   // au-delà, jamais en mémoire

	/* ------------------------------------------------------------------ ZIP (stockage, sans compression) */
	function zipBlob(entries) {
		// entries : { name, parts: [Blob|Uint8Array], size, crc, dir }
		const enc = new TextEncoder(), parts = [], central = [];
		let offset = 0;
		const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
			dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
		for (const e of entries) {
			const name = enc.encode(e.name), lh = new DataView(new ArrayBuffer(30));
			lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, e.dir ? 20 : 10, true); lh.setUint16(6, 0x0800, true);
			lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
			lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true);
			lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
			parts.push(lh.buffer, name, ...e.parts);
			const ch = new DataView(new ArrayBuffer(46));
			ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, e.dir ? 20 : 10, true);
			ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
			ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
			ch.setUint16(28, name.length, true); ch.setUint32(38, e.dir ? 0x10 : 0, true); ch.setUint32(42, offset, true);
			central.push(ch.buffer, name);
			offset += 30 + name.length + e.size;
			if (offset > 0xfffffff0) throw new Error('ZIP > 4 Go');
		}
		const cdSize = central.reduce((a, p) => a + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
		end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
		end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
		return new Blob(parts.concat(central, [end.buffer]), { type: 'application/zip' });
	}

	/* ------------------------------------------------------------------ opérations */
	function applyBps(srcBytes, patchBytes) {
		const rom = new BinFile(srcBytes.slice().buffer), patchBin = new BinFile(patchBytes.slice().buffer);
		const patch = RomPatcher.parsePatchFile(patchBin);
		if (!patch) throw rrError('PATCH_FORMAT');
		const out = RomPatcher.applyPatch(rom, patch, { requireValidation: true, outputSuffix: false });
		const u8 = out._u8array;
		return new Uint8Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + out.fileSize));
	}
	/** Pose des clés dans une section INI, octet pour octet (latin-1). Seules les valeurs visées changent :
	 *  chaque ligne garde sa propre fin de ligne (les fichiers mélangent parfois CRLF et LF). */
	function applyIni(bytes, section, set) {
		let txt = ''; for (let i = 0; i < bytes.length; i++) txt += String.fromCharCode(bytes[i]);
		const parts = txt.split(/(\r?\n)/), done = new Set(), sec = section.toLowerCase();   // [ligne, fin, ligne, fin, …]
		let cur = '', secIdx = -1, eol = '\r\n';
		for (let i = 0; i < parts.length; i += 2) {
			if (parts[i + 1]) eol = parts[i + 1];
			const m = /^\s*\[([^\]]+)\]/.exec(parts[i]);
			if (m) { cur = m[1].trim().toLowerCase(); if (cur === sec) secIdx = i; continue; }
			if (cur !== sec) continue;
			const kv = /^(\s*)([^=;#\s][^=]*?)(\s*=\s*)(.*?)(\s*)$/.exec(parts[i]);
			if (kv && Object.prototype.hasOwnProperty.call(set, kv[2])) { parts[i] = kv[1] + kv[2] + kv[3] + set[kv[2]] + kv[5]; done.add(kv[2]); }
		}
		const missing = Object.keys(set).filter(k => !done.has(k));
		if (missing.length) {
			const add = missing.map(k => k + '=' + set[k] + eol).join('');
			if (secIdx < 0) {
				const last = parts.length - 1;
				if (parts[last] !== '') parts[last] += eol;
				parts[last] += '[' + section + ']' + eol + add;
			} else parts[secIdx + 1] = (parts[secIdx + 1] || eol) + add;
		}
		const out = parts.join(''), u8 = new Uint8Array(out.length);
		for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 0xff;
		return u8;
	}

	function rrError(code, params, detail) { const e = new Error(code); e.rrCode = code; e.rrParams = params || {}; e.rrDetail = detail || ''; return e; }
	const isSha = v => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
	function validateConfig(cfg) {
		const p = [];
		if (!cfg || cfg.mode !== 'folder') return ['mode "folder" attendu'];
		if (!cfg.marker || !cfg.marker.path || !isSha(cfg.marker.sha256)) p.push('marker invalide');
		if (!cfg.output || !cfg.output.fileName) p.push('output.fileName manquant');
		(cfg.files || []).forEach(f => {
			if (f.op === 'bps' || f.op === 'append') {
				if (!isSha(f.source && f.source.sha256) || !isSha(f.target && f.target.sha256) || !isSha(f.patch && f.patch.sha256) || !f.patch.url) p.push('empreintes incomplètes : ' + f.path);
			} else if (f.op === 'copy') { if (!f.from || !isSha(f.target && f.target.sha256)) p.push('copy incomplet : ' + f.path); }
			else if (f.op !== 'ini' && f.op !== 'mkdir') p.push('opération inconnue : ' + f.op);
		});
		if (!(cfg.files || []).length) p.push('aucun fichier');
		return p;
	}

	/* ------------------------------------------------------------------ textes */
	const STRINGS = {
		fr: {
			title: 'Créer votre version {game} Retro Rework v{version}',
			intro: '{game} · Patch officiel v{version} · {system}.',
			privacy: 'Vos fichiers restent sur votre appareil : tout est traité dans votre navigateur, rien n’est envoyé sur Internet.',
			step1: 'Sélectionner le dossier du jeu original',
			step1Help: 'Choisissez le dossier de votre jeu ({expected}) : celui qui contient le dossier « Rally », ou le dossier « Rally » lui-même.',
			step1Note: 'Votre navigateur peut parler d’« importer » ou d’« envoyer » des fichiers : il s’agit seulement de les lire sur votre appareil.',
			chooseFolder: 'Choisir le dossier',
			step2: 'Vérifier et appliquer le patch',
			waiting: 'En attente du dossier du jeu.',
			checking: 'Vérification : {file}… {pct} %',
			checkedOk: 'Jeu reconnu : {expected}. {n} fichiers seront créés ou remplacés.',
			fileSkip: '{file} est déjà à jour : il est laissé tel quel.',
			iniMissing: '{file} est absent : les réglages graphiques recommandés ne seront pas posés.',
			apply: 'Appliquer le patch',
			applying: 'Application : {file}… {pct} %',
			step3: 'Télécharger les fichiers Retro Rework',
			download: 'Télécharger {file}',
			downloadHelp: 'Extrayez cette archive dans le dossier du jeu (celui qui contient « Rally ») et acceptez le remplacement des fichiers. Conservez une copie de votre jeu original.',
			doneOk: 'Patch appliqué et vérifié : chaque fichier produit correspond exactement à la version officielle.',
			errAlreadyPatched: 'Ce dossier contient déjà {game} Retro Rework v{version}. Rien à faire.',
			errNoMarker: 'Fichier « {file} » introuvable dans ce dossier. Choisissez le dossier du jeu.',
			errUnknown: 'Version du jeu non reconnue : {file} ne correspond pas à {expected}.',
			errUnknownHelp: 'Le patch ne s’applique qu’à cette version exacte, non modifiée.',
			errMissing: 'Fichier manquant dans votre jeu : {file}.',
			errSource: 'Ce fichier ne correspond pas à la version d’origine attendue : {file}.',
			errPatchDownload: 'Le patch officiel n’a pas pu être téléchargé. Vérifiez votre connexion et réessayez.',
			errPatchIntegrity: 'Le patch téléchargé est incomplet ou altéré. Réessayez plus tard.',
			errResult: 'Le résultat ne correspond pas à la version officielle ({file}). Aucun fichier n’est proposé.',
			errBrowser: 'Votre navigateur ne permet pas de choisir un dossier. Utilisez une version récente de Chrome, Edge, Firefox ou Safari sur ordinateur.',
			errConfig: 'Configuration du patcheur invalide. Aucun patch ne peut être appliqué.',
			errGeneric: 'Une erreur inattendue est survenue.',
			restart: 'Recommencer', details: 'Détails techniques', credits: 'Crédits', langLabel: 'Langue'
		},
		en: {
			title: 'Create your {game} Retro Rework v{version}',
			intro: '{game} · Official patch v{version} · {system}.',
			privacy: 'Your files stay on your device: everything is processed in your browser, nothing is sent over the Internet.',
			step1: 'Select the original game folder',
			step1Help: 'Choose your game folder ({expected}): the one that contains the “Rally” folder, or the “Rally” folder itself.',
			step1Note: 'Your browser may say it will “upload” files: they are only read on your device.',
			chooseFolder: 'Choose folder',
			step2: 'Check and apply the patch',
			waiting: 'Waiting for the game folder.',
			checking: 'Checking: {file}… {pct}%',
			checkedOk: 'Game recognised: {expected}. {n} files will be created or replaced.',
			fileSkip: '{file} is already up to date: left as is.',
			iniMissing: '{file} is missing: the recommended graphics settings will not be applied.',
			apply: 'Apply the patch',
			applying: 'Applying: {file}… {pct}%',
			step3: 'Download the Retro Rework files',
			download: 'Download {file}',
			downloadHelp: 'Extract this archive into the game folder (the one that contains “Rally”) and accept replacing the files. Keep a copy of your original game.',
			doneOk: 'Patch applied and verified: every file produced matches the official version exactly.',
			errAlreadyPatched: 'This folder already contains {game} Retro Rework v{version}. Nothing to do.',
			errNoMarker: '“{file}” was not found in this folder. Choose the game folder.',
			errUnknown: 'Unrecognised game version: {file} does not match {expected}.',
			errUnknownHelp: 'The patch only applies to this exact, unmodified version.',
			errMissing: 'File missing from your game: {file}.',
			errSource: 'This file does not match the expected original version: {file}.',
			errPatchDownload: 'The official patch could not be downloaded. Check your connection and try again.',
			errPatchIntegrity: 'The downloaded patch is incomplete or corrupted. Try again later.',
			errResult: 'The result does not match the official version ({file}). No file is offered.',
			errBrowser: 'Your browser cannot select a folder. Use a recent desktop version of Chrome, Edge, Firefox or Safari.',
			errConfig: 'Invalid patcher configuration. No patch can be applied.',
			errGeneric: 'An unexpected error occurred.',
			restart: 'Start again', details: 'Technical details', credits: 'Credits', langLabel: 'Language'
		}
	};
	const LANGS = ['fr', 'en'];
	function pickLanguage() {
		const u = new URLSearchParams(location.search).get('lang'); if (LANGS.includes(u)) return u;
		try { const s = localStorage.getItem('rr-patcher-lang'); if (LANGS.includes(s)) return s; } catch (e) { /* stockage indisponible */ }
		return (navigator.language || 'en').slice(0, 2).toLowerCase() === 'fr' ? 'fr' : 'en';
	}
	function el(tag, attrs, children) {
		const n = document.createElement(tag);
		for (const k in (attrs || {})) {
			if (k === 'text') n.textContent = attrs[k];
			else if (k === 'onclick' || k === 'onchange') n[k] = attrs[k];
			else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
		}
		(children || []).forEach(c => c && n.appendChild(c));
		return n;
	}
	const fmt = n => n < 1048576 ? (n / 1024).toFixed(0) + ' Ko' : (n / 1048576).toFixed(1) + ' Mo';
	const base = p => p.replace(/\/$/, '').split('/').pop();

	/* ------------------------------------------------------------------ interface */
	class FolderPatcher {
		constructor(root, cfg, baseUrl) {
			this.root = root; this.cfg = cfg; this.baseUrl = baseUrl; this.lang = pickLanguage();
			this.problems = validateConfig(cfg); this.reset();
		}
		t(k, p) {
			const s = (STRINGS[this.lang] || STRINGS.en)[k] || STRINGS.en[k] || k;
			const all = Object.assign({ game: this.cfg.game, version: this.cfg.version, system: this.cfg.system || '', expected: this.local(this.cfg.expectedText) }, p || {});
			return s.replace(/\{(\w+)\}/g, (m, x) => all[x] != null ? all[x] : m);
		}
		local(o) { return o ? (o[this.lang] || o.en || o.fr || '') : ''; }
		reset() {
			if (this.outputUrl) URL.revokeObjectURL(this.outputUrl);
			this.s = { step: 1, busy: false, progress: '', notes: [], error: null, info: null, tech: [], folder: '' };
			this.plan = null; this.outputUrl = null; this.outputSize = 0;
			if (this.problems.length) { this.fail(rrError('CONFIG_INVALID', {}, this.problems.join(' ; '))); return; }
			this.render();
		}
		fail(e) {
			const map = { NO_MARKER: ['errNoMarker'], UNKNOWN: ['errUnknown', 'errUnknownHelp'], MISSING: ['errMissing'], SOURCE: ['errSource', 'errUnknownHelp'],
				PATCH_DOWNLOAD: ['errPatchDownload'], PATCH_INTEGRITY: ['errPatchIntegrity'], RESULT: ['errResult'], BROWSER: ['errBrowser'], CONFIG_INVALID: ['errConfig'] };
			this.s.error = { keys: map[e && e.rrCode] || ['errGeneric'], params: (e && e.rrParams) || {}, detail: (e && (e.rrDetail || (!e.rrCode && e.message))) || '' };
			this.s.busy = false; this.s.progress = '';
			if (!(e && e.rrCode) && global.console) console.error(e);
			this.render();
		}
		progress(key, file, frac) { this.s.progress = this.t(key, { file, pct: Math.floor(frac * 100) }); this.render(); }

		/** Associe les chemins du jeu (« Rally/... ») aux fichiers choisis, quel que soit le dossier pris. */
		indexFolder(fileList) {
			const files = Array.from(fileList), marker = this.cfg.marker.path, top = marker.split('/')[0], rest = marker.slice(top.length + 1);
			let best = null;
			for (const f of files) {
				const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
				if (rel.toLowerCase() === rest.toLowerCase() || rel.toLowerCase().endsWith('/' + rest.toLowerCase())) {
					const depth = rel.split('/').length; if (!best || depth < best.depth) best = { rel, depth };
				}
			}
			if (!best) throw rrError('NO_MARKER', { file: marker });
			const prefix = best.rel.slice(0, best.rel.length - rest.length);   // dossier qui joue le rôle de « Rally/ »
			const map = new Map();
			for (const f of files) {
				const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
				if (rel.startsWith(prefix)) map.set((top + '/' + rel.slice(prefix.length)).toLowerCase(), f);
			}
			this.s.folder = prefix.split('/')[0] || top;
			return map;
		}

		async onFolder(fileList) {
			this.reset(); if (this.problems.length) return;
			if (!fileList || !fileList.length) return;
			this.s.busy = true; this.render();
			try {
				const map = this.indexFolder(fileList), get = p => map.get(p.toLowerCase());
				const cfg = this.cfg, plan = [];
				// 1) marqueur : jeu d'origine, déjà patché ou inconnu
				const mk = get(cfg.marker.path);
				const mkScan = await scan(mk, true);
				const mkSha = mkScan.sha.hex();
				this.s.tech.push([cfg.marker.path, fmt(mk.size) + ' — SHA-256 ' + mkSha]);
				if (mkSha === cfg.marker.patchedSha256) { this.s.busy = false; this.s.info = 'errAlreadyPatched'; this.render(); return; }
				if (mkSha !== cfg.marker.sha256) throw rrError('UNKNOWN', { file: cfg.marker.path }, 'SHA-256 ' + mkSha);
				// 2) chaque fichier utile
				for (const f of cfg.files) {
					if (f.op === 'mkdir') { plan.push({ f }); continue; }
					const srcPath = f.op === 'copy' ? f.from : f.path, file = get(srcPath);
					if (!file) {
						if (f.optional) { this.s.notes.push(['iniMissing', { file: f.path }]); continue; }
						throw rrError('MISSING', { file: srcPath });
					}
					if (f.op === 'ini') { plan.push({ f, file, bytes: await readBlob(file) }); continue; }
					const keep = file.size <= KEEP_LIMIT;
					const r = file === mk ? mkScan : await scan(file, keep, x => this.progress('checking', base(srcPath), x));
					const sha = r.sha.hex();
					this.s.tech.push([srcPath, fmt(file.size) + ' — SHA-256 ' + sha]);
					if (f.op !== 'copy' && sha === f.target.sha256) { this.s.notes.push(['fileSkip', { file: f.path }]); continue; }
					const want = f.op === 'copy' ? f.target.sha256 : f.source.sha256;
					if (sha !== want) throw rrError('SOURCE', { file: srcPath }, 'SHA-256 ' + sha);
					plan.push({ f, file, scan: r });
				}
				this.plan = plan;
				this.s.notes.unshift(['checkedOk', { n: plan.filter(p => p.f.op !== 'mkdir').length }]);
				this.s.step = 2; this.s.busy = false; this.s.progress = ''; this.render();
			} catch (e) { this.fail(e); }
		}

		async fetchPatch(p) {
			let res;
			try { res = await fetch(new URL(p.url, this.baseUrl), { cache: 'no-cache' }); } catch (e) { throw rrError('PATCH_DOWNLOAD', {}, String(e)); }
			if (!res.ok) throw rrError('PATCH_DOWNLOAD', {}, 'HTTP ' + res.status + ' ' + p.url);
			const b = new Uint8Array(await res.arrayBuffer()), sha = new Sha256().update(b).hex();
			if (sha !== p.sha256) throw rrError('PATCH_INTEGRITY', {}, p.url + ' SHA-256 ' + sha);
			return b;
		}

		async onApply() {
			this.s.error = null; this.s.busy = true; this.render();
			try {
				const entries = [];
				for (const it of this.plan) {
					const f = it.f, name = f.path;
					this.progress('applying', base(name), 0);
					if (f.op === 'mkdir') { entries.push({ name: name.endsWith('/') ? name : name + '/', parts: [], size: 0, crc: 0, dir: true }); continue; }
					if (f.op === 'bps') {
						const src = it.scan.bytes || await readBlob(it.file);
						const out = applyBps(src, await this.fetchPatch(f.patch));
						const sha = new Sha256().update(out).hex();
						if (sha !== f.target.sha256 || out.length !== f.target.size) throw rrError('RESULT', { file: name }, 'SHA-256 ' + sha);
						entries.push({ name, parts: [out], size: out.length, crc: new Crc32().update(out).value() });
					} else if (f.op === 'append') {
						const tail = await this.fetchPatch(f.patch);
						const sha = it.scan.sha.clone().update(tail).hex(), crc = it.scan.crc.clone().update(tail).value();
						const size = it.file.size + tail.length;
						if (sha !== f.target.sha256 || size !== f.target.size) throw rrError('RESULT', { file: name }, 'SHA-256 ' + sha);
						entries.push({ name, parts: [it.file, tail], size, crc });
					} else if (f.op === 'copy') {
						entries.push({ name, parts: [it.file], size: it.file.size, crc: it.scan.crc.value() });
					} else if (f.op === 'ini') {
						const out = applyIni(it.bytes, f.section, f.set);
						entries.push({ name, parts: [out], size: out.length, crc: new Crc32().update(out).value() });
					}
					this.s.tech.push(['→ ' + name, f.op]);
				}
				const zip = zipBlob(entries);
				this.outputSize = zip.size;
				this.outputUrl = URL.createObjectURL(zip);
				this.s.notes.push(['doneOk']);
				this.s.step = 3; this.s.busy = false; this.s.progress = ''; this.render();
			} catch (e) { this.fail(e); }
		}

		setLang(l) { this.lang = l; try { localStorage.setItem('rr-patcher-lang', l); } catch (e) { /* stockage indisponible */ } this.render(); }

		render() {
			const s = this.s, cfg = this.cfg, box = el('div', { class: 'rrp' });
			const langs = el('div', { class: 'rrp-langs', role: 'group', 'aria-label': this.t('langLabel') },
				LANGS.map(l => el('button', { type: 'button', class: 'rrp-lang' + (l === this.lang ? ' is-active' : ''), 'aria-pressed': String(l === this.lang), text: l.toUpperCase(), onclick: () => this.setLang(l) })));
			box.appendChild(el('div', { class: 'rrp-head' }, [el('h2', { class: 'rrp-title', text: this.t('title') }), langs]));
			box.appendChild(el('p', { class: 'rrp-intro', text: this.t('intro') }));
			box.appendChild(el('p', { class: 'rrp-privacy', text: '🔒 ' + this.t('privacy') }));
			const card = (n, key, content) => el('section', { class: 'rrp-step' + (n === s.step ? ' is-current' : '') + (n < s.step ? ' is-done' : '') }, [
				el('div', { class: 'rrp-step-head' }, [el('span', { class: 'rrp-num', text: n < s.step ? '✓' : String(n) }), el('h3', { text: this.t(key) })]),
				el('div', { class: 'rrp-step-body' }, content)]);

			const off = this.problems.length > 0 || s.busy;
			const input = el('input', { type: 'file', id: 'rrfp-dir', class: 'rrp-file', webkitdirectory: '', directory: '', multiple: '', disabled: off ? 'disabled' : false });
			input.onchange = () => this.onFolder(input.files);
			box.appendChild(card(1, 'step1', [
				el('p', { class: 'rrp-help', text: this.t('step1Help') }),
				el('label', { for: 'rrfp-dir', class: 'rrp-btn ' + (s.step === 1 && !off ? 'rrp-btn-primary' : 'rrp-btn-ghost'), 'aria-disabled': off ? 'true' : false }, [el('span', { text: s.folder || this.t('chooseFolder') })]),
				input,
				el('p', { class: 'rrp-muted', text: this.t('step1Note') })]));

			const b2 = [];
			if (s.step === 1) b2.push(el('p', { class: 'rrp-muted', text: s.progress || this.t('waiting') }));
			s.notes.forEach(([k, p]) => { if (k !== 'doneOk') b2.push(el('p', { class: 'rrp-ok', text: this.t(k, p) })); });
			if (s.step === 2) {
				if (s.progress) b2.push(el('p', { class: 'rrp-muted', role: 'status', text: s.progress }));
				b2.push(el('button', { type: 'button', class: 'rrp-btn rrp-btn-primary', disabled: s.busy ? 'disabled' : false, onclick: () => this.onApply(), text: this.t('apply') }));
			}
			box.appendChild(card(2, 'step2', b2));

			const b3 = [];
			if (s.step === 3) {
				b3.push(el('p', { class: 'rrp-ok', text: this.t('doneOk') }));
				b3.push(el('a', { class: 'rrp-btn rrp-btn-primary rrp-download', href: this.outputUrl, download: cfg.output.fileName, text: '⬇ ' + this.t('download', { file: cfg.output.fileName }) + ' (' + fmt(this.outputSize) + ')' }));
				b3.push(el('p', { class: 'rrp-help', text: this.t('downloadHelp') }));
			}
			box.appendChild(card(3, 'step3', b3));

			if (s.info) box.appendChild(el('div', { class: 'rrp-alert rrp-alert-info', role: 'status' }, [el('p', { text: this.t(s.info) })]));
			if (s.error) box.appendChild(el('div', { class: 'rrp-alert rrp-alert-error', role: 'alert' }, s.error.keys.map(k => el('p', { text: this.t(k, s.error.params) }))));
			if (!this.problems.length && (s.step !== 1 || s.error || s.info) && !s.busy)
				box.appendChild(el('button', { type: 'button', class: 'rrp-btn rrp-btn-ghost rrp-restart', onclick: () => this.reset(), text: this.t('restart') }));
			if (s.tech.length || (s.error && s.error.detail)) {
				const rows = s.tech.map(([k, v]) => el('div', { class: 'rrp-tech-row' }, [el('span', { text: k }), el('code', { text: v })]));
				if (s.error && s.error.detail) rows.push(el('div', { class: 'rrp-tech-row' }, [el('span', { text: 'Info' }), el('code', { text: s.error.detail })]));
				box.appendChild(el('details', { class: 'rrp-tech' }, [el('summary', { text: this.t('details') })].concat(rows)));
			}
			if (cfg.links && cfg.links.credits)
				box.appendChild(el('p', { class: 'rrp-foot' }, [el('a', { href: cfg.links.credits, target: '_blank', rel: 'noopener noreferrer', text: this.t('credits') + ' ↗' })]));
			const focused = document.activeElement && document.activeElement.closest && this.root.contains(document.activeElement);
			this.root.replaceChildren(box);
			this.root.setAttribute('lang', this.lang);
			if (focused && s.step === 2 && !s.busy) { const b = this.root.querySelector('.rrp-step.is-current .rrp-btn-primary'); if (b) b.focus(); }
			postHeight();
		}
	}

	function postHeight() {
		if (global.parent && global.parent !== global)
			global.parent.postMessage({ type: 'rr-patcher:height', height: Math.ceil(document.documentElement.getBoundingClientRect().height) }, '*');
	}
	if (typeof ResizeObserver === 'function') new ResizeObserver(postHeight).observe(document.documentElement);

	async function mount(root, opts) {
		const baseUrl = (opts && opts.baseUrl) || document.baseURI;
		try {
			const probe = document.createElement('input');
			if (typeof fetch !== 'function' || typeof Blob !== 'function' || !('webkitdirectory' in probe)) {
				root.textContent = STRINGS[pickLanguage()].errBrowser; return null;
			}
			const res = await fetch(new URL(opts.configUrl, baseUrl), { cache: 'no-cache' });
			if (!res.ok) throw new Error('config HTTP ' + res.status);
			const p = new FolderPatcher(root, await res.json(), baseUrl);
			root.rrPatcher = p; return p;
		} catch (e) { root.textContent = 'Retro Rework Patcher : configuration introuvable / configuration not found.'; throw e; }
	}
	function autoStart() {
		const root = document.querySelector('#rr-folder-patcher, #rr-patcher[data-mode="folder"]'); if (!root) return;
		const theme = new URLSearchParams(location.search).get('theme');
		if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
		const game = root.getAttribute('data-game') || new URLSearchParams(location.search).get('game') || '';
		if (!/^[a-z0-9-]+$/.test(game)) { root.textContent = 'Retro Rework Patcher : ?game=<id> manquant / missing.'; return; }
		mount(root, { configUrl: 'games/' + game + '.json', baseUrl: root.getAttribute('data-base') || document.baseURI });
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart); else autoStart();

	global.RRFolderPatcher = { mount, FolderPatcher, Sha256, Crc32, applyIni, zipBlob, validateConfig };
})(window);
