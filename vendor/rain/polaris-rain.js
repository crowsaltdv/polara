// Polaris glue for the Codrops RainEffect (see README.txt).
// Turns the chosen background image into the two textures the effect wants (a sharp one that
// shows through the drops and a blurred one for the glass) and manages size, start/stop and parallax.
import Raindrops from "./raindrops.js";
import RainRenderer from "./rain-renderer.js";
import createCanvas from "./create-canvas.js";

function loadImg(src, cors = false) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		if (cors) img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image failed to load"));
		img.src = src;
	});
}

// WebGL may only read images that allow it (CORS). Try the image directly first; only if its host refuses do we
// fetch it through our own server, which keeps the bandwidth off your hosting whenever possible.
async function loadPicture(url) {
	if (!/^https?:/i.test(url)) return loadImg(url);
	try {
		return await loadImg(url, true);
	} catch {
		return loadImg("/api/img?u=" + encodeURIComponent(url));
	}
}

function makeTextures(img, blur) {
	const ratio = img.naturalHeight / img.naturalWidth;
	// seen through the drops: small and soft, like the original demo
	const fg = createCanvas(256, Math.max(2, Math.round(256 * ratio)));
	fg.getContext("2d").drawImage(img, 0, 0, fg.width, fg.height);

	// the glass itself: the picture, blurred by the user's blur setting
	const bw = 1024;
	const bh = Math.max(2, Math.round(bw * ratio));
	const bg = createCanvas(bw, bh);
	const bx = bg.getContext("2d");
	if (blur > 0 && "filter" in bx) {
		const px = (blur * bw) / 1280;
		bx.filter = `blur(${px}px)`;
		bx.drawImage(img, -px * 2, -px * 2, bw + px * 4, bh + px * 4);
	} else if (blur > 0) {
		const sw = Math.max(8, Math.round(bw / (1 + blur * 0.6)));
		const small = createCanvas(sw, Math.max(2, Math.round(sw * ratio)));
		small.getContext("2d").drawImage(img, 0, 0, small.width, small.height);
		bx.imageSmoothingQuality = "high";
		bx.drawImage(small, 0, 0, bw, bh);
	} else {
		bx.drawImage(img, 0, 0, bw, bh);
	}
	return { fg, bg };
}

export function createRainFx(canvas) {
	let renderer = null;
	let drops = null;
	let dropAlpha = null;
	let dropColor = null;
	let running = false;
	let size = "";
	let px = 0;
	let py = 0;
	let tx = 0;
	let ty = 0;
	let raf = 0;
	const api = { ready: false };

	async function loadDropArt() {
		if (dropAlpha) return;
		[dropAlpha, dropColor] = await Promise.all([
			loadImg(new URL("./img/drop-alpha.png", import.meta.url).href),
			loadImg(new URL("./img/drop-color.png", import.meta.url).href),
		]);
	}

	function build(fg, bg) {
		if (renderer) renderer.stop();
		if (drops) drops.stop();
		const q = Math.min(window.devicePixelRatio || 1, 1.25);
		canvas.width = Math.round(window.innerWidth * q);
		canvas.height = Math.round(window.innerHeight * q);
		drops = new Raindrops(canvas.width, canvas.height, q, dropAlpha, dropColor, {
			trailRate: 1,
			trailScaleRange: [0.2, 0.45],
			collisionRadius: 0.45,
			dropletsCleaningRadiusMultiplier: 0.28,
		});
		renderer = new RainRenderer(canvas, drops.canvas, fg, bg, null, {
			brightness: 1.04,
			alphaMultiply: 6,
			alphaSubtract: 3,
		});
		renderer.gl.gl.viewport(0, 0, canvas.width, canvas.height);
		if (!running) {
			drops.stop();
			renderer.stop();
		}
		size = canvas.width + "x" + canvas.height;
	}

	function tick() {
		if (!running) return;
		px += (tx - px) * 0.06;
		py += (ty - py) * 0.06;
		if (renderer) {
			renderer.parallaxX = px;
			renderer.parallaxY = py;
		}
		raf = requestAnimationFrame(tick);
	}

	addEventListener("pointermove", (e) => {
		tx = (e.clientX / window.innerWidth) * 2 - 1;
		ty = (e.clientY / window.innerHeight) * 2 - 1;
	});

	api.setScene = async (url, blur) => {
		await loadDropArt();
		const img = await loadPicture(url);
		const { fg, bg } = makeTextures(img, blur || 0);
		const want = Math.round(window.innerWidth * Math.min(window.devicePixelRatio || 1, 1.25)) + "x" +
			Math.round(window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.25));
		if (!renderer || want !== size) build(fg, bg);
		else renderer.setImages(fg, bg);
		api.ready = true;
	};
	api.start = () => {
		if (running) return;
		running = true;
		if (renderer) {
			drops.start();
			renderer.start();
		}
		raf = requestAnimationFrame(tick);
	};
	api.stop = () => {
		running = false;
		cancelAnimationFrame(raf);
		if (renderer) {
			drops.stop();
			renderer.stop();
		}
	};
	return api;
}
