/* Polaris guard: the server inlines this at the top of every game page.
   Many game pages pull in advertising and tracking code (Google ad scripts, cdn.r9x.in, analytics). That code would run on
   Polaris' own origin, next to the chat session, so it is stopped from loading, connecting or reporting back. The games
   themselves are untouched. */
(function () {
	var BAD = new RegExp("(^|\\.)(" + [/*HOSTS*/].join("|").replace(/\./g, "\\.") + ")$", "i"); // the server fills in the host list (adhosts.js)
	function bad(u) {
		try {
			return BAD.test(new URL(String(u), location.href).hostname);
		} catch (e) {
			return false;
		}
	}
	function blocked(el) {
		// let the page carry on as if the load had simply failed
		setTimeout(function () {
			try {
				el.dispatchEvent(new Event("error"));
			} catch (e) {}
		}, 0);
	}
	function patchSrc(proto) {
		var d = Object.getOwnPropertyDescriptor(proto, "src");
		if (!d || !d.set) return;
		Object.defineProperty(proto, "src", {
			configurable: true,
			enumerable: d.enumerable,
			get: d.get,
			set: function (v) {
				if (bad(v)) return blocked(this);
				d.set.call(this, v);
			},
		});
	}
	patchSrc(HTMLScriptElement.prototype);
	patchSrc(HTMLIFrameElement.prototype);
	patchSrc(HTMLImageElement.prototype);
	var setAttr = Element.prototype.setAttribute;
	Element.prototype.setAttribute = function (n, v) {
		if (/^src$/i.test(n) && /^(script|iframe|img)$/i.test(this.tagName) && bad(v)) return blocked(this);
		return setAttr.apply(this, arguments);
	};
	if (window.fetch) {
		var f = window.fetch;
		window.fetch = function (r) {
			if (bad(r && r.url ? r.url : r)) return Promise.reject(new TypeError("Failed to fetch"));
			return f.apply(this, arguments);
		};
	}
	var open = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (m, u) {
		if (bad(u)) arguments[1] = "about:blank";
		return open.apply(this, arguments);
	};
	if (window.WebSocket) {
		var WS = window.WebSocket;
		var Guarded = function (u, p) {
			if (bad(u)) throw new DOMException("The connection was refused.", "SecurityError");
			return arguments.length > 1 ? new WS(u, p) : new WS(u);
		};
		Guarded.prototype = WS.prototype;
		["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
			Guarded[k] = WS[k];
		});
		window.WebSocket = Guarded;
	}
	if (navigator.sendBeacon) {
		var sb = navigator.sendBeacon;
		navigator.sendBeacon = function (u) {
			return bad(u) ? false : sb.apply(this, arguments);
		};
	}
})();
