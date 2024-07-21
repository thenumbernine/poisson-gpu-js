import {vec2} from '/js/gl-matrix-3.4.1/index.js';
import {DOM, getIDs, removeFromParent} from '/js/util.js';
import {GLUtil} from '/js/gl-util.js';
import {Mouse3D} from '/js/mouse3d.js';
import {makeGradient} from '/js/gl-util-Gradient.js';
import {makeUnitQuad} from '/js/gl-util-UnitQuad.js';
import {makeKernel} from '/js/gl-util-Kernel.js';
import {makeFloatTexture2D} from '/js/gl-util-FloatTexture2D.js';

const ids = getIDs();
window.ids = ids;

const urlparams = new URLSearchParams(location.search);

let res = +urlparams.get('size');
if (!res || !isFinite(res)) res = 1024;

/*
algorithm:
1) user draws into density buffer
2) jacobi relaxation of inverse discrete poisson to calculate potential buffer
3) min/max reduce across potential
4) heat map render

TODO
https://ir.library.oregonstate.edu/xmlui/bitstream/handle/1957/28524/Interactive%20tensor%20field%20design%20and%20visualization%20on%20surfaces.pdf?sequence=1
*/

let glutil;
let gl;

//fbo
let fbo;
let quadObj;
//textures
let heatTex;
let densityTex;
let potentialTex;
let displayTex;	//fbo renders whatever draw mode to this tex, then reduce finds the extents, then this is drawn with colors normalized
let reduceTex;	//scratch tex for finding the min/max
let tmpTex;
//shaders
let displayShaders = {};
let drawHeatShader;
let addDropShader;
let relaxShader;
let initReduceShader;
let reduceShader;
let encodeShaders = [];
//vars
let currentDrawMode;
let lastDataMin = 0;
let lastDataMax = 1;
let inputMethod = document.querySelector('input[name="inputMethod"]:checked').value;

function drawDisplayTex() {
	//display
	glutil.UnitQuad.unitQuad.draw({
		shader : drawHeatShader,
		uniforms : {
			lastMin : lastDataMin,
			lastMax : lastDataMax
		},
		texs : [
			displayTex,
			heatTex
		]
	});
}

function generateDisplayTex() {
	//generate display texture
	fbo.draw({
		viewport : [0,0,res,res],
		dest : tmpTex.obj,
		callback : () => {
			quadObj.draw({
				shader : displayShaders[currentDrawMode.name],
				texs : [potentialTex, densityTex],
			});
		},
	});
	let tmp = tmpTex;
	tmpTex = displayTex;
	displayTex = tmp;
}

function relaxJacobiBuffer() {
	//relax buffer
	fbo.draw({
		viewport : [0,0,res,res],
		dest : tmpTex,
		callback : () => {
			quadObj.draw({
				shader : relaxShader,
				texs : [potentialTex, densityTex]
			});
		}
	});
	let tmp = tmpTex;
	tmpTex = potentialTex;
	potentialTex = tmp;
}

function reduceDisplayTex() {
	//init reduceTex
	fbo.draw({
		viewport : [0,0,res,res],
		dest : tmpTex,
		callback : () => {
			quadObj.draw({
				shader : initReduceShader,
				texs : [displayTex]
			});
		}
	});
	let tmp = tmpTex;
	tmpTex = reduceTex;
	reduceTex = tmp;

	//reduce to 1x1
	let size = res;
	while (size > 1) {
		size /= 2;
		if (size !== Math.floor(size)) throw 'got np2 size '+res;

		fbo.draw({
			viewport : [0,0,size,size],
			dest : tmpTex,
			callback : () => {
				quadObj.draw({
					shader : reduceShader,
					uniforms : {
						texsize : [res, res],
						viewsize : [size, size]
					},
					texs : [reduceTex]
				});
			}
		});
		let tmp = tmpTex;
		tmpTex = reduceTex;
		reduceTex = tmp;
	}

return;
	//extract the min/max from the last
	fbo.draw({
		dest : tmpTex,
		viewport : [0, 0, res, res],
		callback : () => {
			//TODO we don't need to draw to the whole quad if we're just going to read back the 1x1 corner pixel
			let reduceUInt8Result = new Uint8Array(4);
			//read min
			quadObj.draw({
				shader : encodeShaders[0],	//read channel 0 (red) from pixel 0,0
				texs : [reduceTex]
			});
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, reduceUInt8Result);
			lastDataMin = (new Float32Array(reduceUInt8Result.buffer))[0];
			//read max
			quadObj.draw({
				shader : encodeShaders[1],	//read channel 1 (green) from pixel 0,0
				texs : [reduceTex]
			});
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, reduceUInt8Result);
			lastDataMax = (new Float32Array(reduceUInt8Result.buffer))[0];
		},
	});
}

function update() {
	let canvas = glutil.canvas;
	gl.viewport(0, 0, canvas.width, canvas.height);

	//just clears the buffer.  no scenegraph to draw
	glutil.draw();

	drawDisplayTex();	//draw old display tex to screen
	generateDisplayTex();	//generate new display tex
	relaxJacobiBuffer();	//relax density into potential
	reduceDisplayTex();		//reduce display tex to get min/max

	//update
	window.requestAnimationFrame(update);
}

function onresize() {
	glutil.canvas.width = window.innerWidth;
	glutil.canvas.height = window.innerHeight;
	glutil.resize();
}

let canvas = DOM('canvas', {
	css : {
		left : 0,
		top : 0,
		position : 'absolute',
		background : 'red',
		userSelect : 'none',
	},
	prependTo : document.body,
});

try {
	glutil = new GLUtil({canvas:canvas});
	gl = glutil.context;
} catch (e) {
	removeFromParent(ids.menu);
	removeFromParent(canvas);
	show(ids.webglfail);
	throw e;
}
glutil.import('Gradient', makeGradient);
glutil.import('UnitQuad', makeUnitQuad);
glutil.import('Kernel', makeKernel);
glutil.import('FloatTexture2D', makeFloatTexture2D);

let maxsize =  gl.getParameter(gl.MAX_TEXTURE_SIZE);
if (res > maxsize) res = maxsize;

glutil.view.ortho = true;
glutil.view.zNear = -1;
glutil.view.zFar = 1;
glutil.view.fovY = .5;
glutil.view.pos[0] = .5;
glutil.view.pos[1] = .5;

gl.clearColor(0,0,0,1);

// heat map gradient texture

heatTex = new glutil.Gradient.GradientTexture({
	width : 256,
	colors : [
		[.5, 0, 0],
		[1, 1, 0],
		[0, 0, .5],
		[0, 0, 0],
	],
	//dontRepeat : true
});
heatTex.bind();
heatTex.setWrap({
	s : gl.REPEAT
});
heatTex.unbind();

densityTex = new glutil.FloatTexture2D({width:res, height:res, data:()=>{return[0,0,0,0];}});
potentialTex = new glutil.FloatTexture2D({width:res, height:res, data:()=>{return[0,0,0,0];}});
displayTex = new glutil.FloatTexture2D({width:res, height:res, data:()=>{return[0,0,0,0];}});
reduceTex = new glutil.FloatTexture2D({width:res, height:res});
tmpTex = new glutil.FloatTexture2D({width:res, height:res});

const allFloatTexs = [densityTex, potentialTex, displayTex, reduceTex, tmpTex];

// shaders

//TODO generate radio inputs
let drawModes = [
	{
		name : 'density',
		code : `
return texture(densityTex, pos).r;
`
	},
	{
		name : 'potential',
		code : `
return texture(potentialTex, pos).r;
`
	},
	{
		name : 'field',
		code : `
float phiXP = texture(potentialTex, pos + vec2(dx, 0.)).r;
float phiXN = texture(potentialTex, pos - vec2(dx, 0.)).r;
float phiYP = texture(potentialTex, pos + vec2(0., dx)).r;
float phiYN = texture(potentialTex, pos - vec2(0., dx)).r;
vec2 dphi_d;
dphi_d.x = (phiXP - phiXN) / (2. * dx);
dphi_d.y = (phiYP - phiYN) / (2. * dx);
return length(dphi_d);
`
	},
	{
		name : 'angle',
		code : `
float phiXP = texture(potentialTex, pos + vec2(dx, 0.)).r;
float phiXN = texture(potentialTex, pos - vec2(dx, 0.)).r;
float phiYP = texture(potentialTex, pos + vec2(0., dx)).r;
float phiYN = texture(potentialTex, pos - vec2(0., dx)).r;
vec2 dphi_d;
dphi_d.x = (phiXP - phiXN) / (2. * dx);
dphi_d.y = (phiYP - phiYN) / (2. * dx);
const float pi = 3.141592653589793115997963468544185161590576171875;
return atan(dphi_d.y, dphi_d.x) / (2. * pi);
`
	}
];

drawModes.forEach(drawMode => {
	drawMode.radio = DOM('input', {
		type : 'radio',
		name : 'drawMode',
		click : () => { currentDrawMode = drawMode; },
		appendTo : ids.panel,
	});
	DOM('span', {text : drawMode.name, appendTo : ids.panel });
	DOM('br', {appendTo : ids.panel});

	displayShaders[drawMode.name] = new glutil.Kernel({
		code :
`const float dx = `+glutil.tonumber(1/res)+`;

float calcValue() {
` + drawMode.code + `
}

out vec4 fragColor;
void main() {
	float v = calcValue();
	fragColor = vec4(v, 0., 0., 1.);
}
`,
		texs : ['potentialTex', 'densityTex']
	});
});

//set defaults
currentDrawMode = drawModes[drawModes.findIndex(obj => { return obj.name == 'angle'; })];
currentDrawMode.radio.checked = true;

drawHeatShader = new glutil.Program({
	vertexCode : `
in vec2 vertex;
out vec2 pos;
uniform mat4 mvMat;
uniform mat4 projMat;
void main() {
	pos = vertex;
	gl_Position = projMat * mvMat * vec4(vertex.xy, 0., 1.);
}
`,
	fragmentCode : `
in vec2 pos;
uniform sampler2D displayTex;
uniform sampler2D heatTex;
uniform float lastMin, lastMax;
out vec4 fragColor;
void main() {
	float v = texture(displayTex, pos).r;
	v = (v - lastMin) / (lastMax - lastMin);
	fragColor = texture(heatTex, vec2(v, .5));
}
`,
	uniforms : {
		displayTex : 0,
		heatTex : 1
	}
});

/*
(d/dx^2 + d/dy^2) phi = 4 pi rho

d/dx^2 phi ~= (phi[x+dx] + phi[x-dx] - 2*phi[x]) / dx^2
d/dy^2 phi ~= (phi[y+dy] + phi[y-dy] - 2*phi[y]) / dy^2
assume dx = dy ...
(d/dx^2 + d/dy^2) phi ~= (phi[x+dx] + phi[x-dx] + phi[y+dy] + phi[y-dy] - 4*phi[x,y]) / dx^2

partial equations:
(phi[x+dx] + phi[x-dx] + phi[y+dy] + phi[y-dy] - 4*phi[x,y]) / dx^2 = 4 pi rho

jacobi update:
phi[n+1,x,y] = (4 pi rho[x] - (phi[x+dx] + phi[x-dx] + phi[y+dy] + phi[y-dy])) / (-4 phi[x,y])
phi[n+1,x,y] = (-pi rho[x] + 1/4 (phi[x+dx] + phi[x-dx] + phi[y+dy] + phi[y-dy])) / phi[x,y]

TODO a better 2D 3x3 kernel inverse?  block tridiagonal maybe
*/
relaxShader = new glutil.Kernel({
	code :
`const float dx = `+glutil.tonumber(1/res)+`;
out vec4 fragColor;
void main() {
	float rho = texture(densityTex, pos).r;
	float phi = texture(potentialTex, pos).r;
	float phiXP = texture(potentialTex, pos + vec2(dx, 0.)).r;
	float phiXN = texture(potentialTex, pos - vec2(dx, 0.)).r;
	float phiYP = texture(potentialTex, pos + vec2(0., dx)).r;
	float phiYN = texture(potentialTex, pos - vec2(0., dx)).r;
	const float pi = 3.141592653589793115997963468544185161590576171875;
	const float gravConst = 10000.;//1./(dx*dx);

	//TODO boundary conditions
	// if we're some sort of solid flag then don't update ... just fill in with the density

	float newPhi = (4. * pi * dx * dx * gravConst * rho - (phiXP + phiXN + phiYP + phiYN)) / -4.;
	fragColor = vec4(newPhi, 0., 0., 1.);
}
`,
		texs : ['potentialTex', 'densityTex']
	});

	//initReduce: map channel x to xy
	initReduceShader = new glutil.Kernel({
		code : `
out vec4 fragColor;
void main() {
	fragColor = texture(tex, pos).xxzw;
}
`,
	texs : ['tex']
});

//reduce: reduce the mins of the x's and the maxs of the y's
reduceShader = new glutil.Kernel({
	code : `
out vec4 fragColor;
void main() {
	vec2 intPos = pos * viewsize - .5;

	//get four pixels to reduce to one ...
	//x holds the min, y holds the max
	vec2 a = texture(tex, (intPos * 2. + .5) / texsize).xy;
	vec2 b = texture(tex, (intPos * 2. + vec2(1., 0.) + .5) / texsize).xy;
	vec2 c = texture(tex, (intPos * 2. + vec2(0., 1.) + .5) / texsize).xy;
	vec2 d = texture(tex, (intPos * 2. + vec2(1., 1.) + .5) / texsize).xy;

	//final min
	float e = min(a.x, b.x);
	float f = min(c.x, d.x);
	float g = min(e, f);

	//final max
	float h = max(a.y, b.y);
	float i = max(c.y, d.y);
	float j = max(h, i);

	fragColor = vec4(g, j, 0., 0.);

}
`,
	uniforms : {
		texsize : 'vec2',
		viewsize : 'vec2'
	},
	texs : ['tex']
});

//http://lab.concord.org/experiments/webgl-gpgpu/webgl.html
for (let channel = 0; channel < 4; ++channel) {
	encodeShaders[channel] = new glutil.Kernel({
		code : `
float shift_right(float v, float amt) {
	v = floor(v) + 0.5;
	return floor(v / exp2(amt));
}

float shift_left(float v, float amt) {
	return floor(v * exp2(amt) + 0.5);
}

float mask_last(float v, float bits) {
	return mod(v, shift_left(1.0, bits));
}

float extract_bits(float num, float from, float to) {
	from = floor(from + 0.5);
	to = floor(to + 0.5);
	return mask_last(shift_right(num, from), to - from);
}

vec4 encode_float(float val) {
	if (val == 0.0)
		return vec4(0, 0, 0, 0);
	float sign = val > 0.0 ? 0.0 : 1.0;
	val = abs(val);
	float exponent = floor(log2(val));
	float biased_exponent = exponent + 127.0;
	float fraction = ((val / exp2(exponent)) - 1.0) * 8388608.0;

	float t = biased_exponent / 2.0;
	float last_bit_of_biased_exponent = fract(t) * 2.0;
	float remaining_bits_of_biased_exponent = floor(t);

	float byte4 = extract_bits(fraction, 0.0, 8.0) / 255.0;
	float byte3 = extract_bits(fraction, 8.0, 16.0) / 255.0;
	float byte2 = (last_bit_of_biased_exponent * 128.0 + extract_bits(fraction, 16.0, 23.0)) / 255.0;
	float byte1 = (sign * 128.0 + remaining_bits_of_biased_exponent) / 255.0;
	return vec4(byte4, byte3, byte2, byte1);
}

out vec4 fragColor;
void main() {
	vec4 data = texture(tex, pos);
	fragColor = encode_float(data[$channel]);
}
`.replace(/\$channel/g, channel),
		texs : ['tex']
	});
}



addDropShader = new glutil.Kernel({
	code : `
out vec4 fragColor;
void main() {

	//distance from line segment between mousePos and mouseLastPos
	vec2 mouseDelta = mousePos - mouseLastPos;
	float mouseDeltaLenSq = dot(mouseDelta, mouseDelta);
	float t;
	if (mouseDeltaLenSq < 1e-5) {
		t = 0.;
	} else {
		vec2 posToLine = pos - mouseLastPos;
		t = dot(posToLine, mouseDelta) / mouseDeltaLenSq;
	}
	t = clamp(t, 0., 1.);
	vec2 closest = mix(mouseLastPos, mousePos, t);

	float len = length(pos - closest);

	const float epsilon = .001;
	float infl = smoothstep(-radius-epsilon, -radius+epsilon, -len);
	fragColor = texture(tex, pos);
	fragColor.r = mix(fragColor.r, color, infl);
}
`,
	uniforms : {
		color : ['float', 1],
		radius : ['float', 2/res],
		mousePos : 'vec2',
		mouseLastPos : 'vec2'
	},
	texs : ['tex']
});

quadObj = glutil.UnitQuad.unitQuad;

fbo = new glutil.Framebuffer({
	width : res,	//shouldn't need size since there is no depth component
	height : res,
});

function reset() {
	allFloatTexs.forEach(tex => {
		fbo.draw({
			dest : tex,
			viewport : [0, 0, res, res],
			callback : () => {
				gl.clear(gl.COLOR_BUFFER_BIT);
			},
		});
	});
}
reset();

const mousePos = vec2.create();
let mouseLastPos = vec2.create();
let mouse;
const updateMousePos = () => {
	mouseLastPos[0] = mousePos[0];
	mouseLastPos[1] = mousePos[1];

	let ar = canvas.width / canvas.height;
	let thisX = (mouse.xf - .5) * 2 * glutil.view.fovY * ar + glutil.view.pos[0];
	let thisY = (1 - mouse.yf - .5) * 2 * glutil.view.fovY + glutil.view.pos[1];
	mousePos[0] = thisX;
	mousePos[1] = thisY;
};
const createDrop = () => {
	//add to density kernel  ...
	fbo.draw({
		viewport : [0,0,res,res],
		dest : tmpTex,
		callback : () => {
			quadObj.draw({
				shader : addDropShader,
				texs : [densityTex],
				uniforms : {
					mousePos : mousePos,
					mouseLastPos : mouseLastPos
				}
			});
		}
	});
	let tmp = tmpTex;
	tmpTex = densityTex;
	densityTex = tmp;
};
mouse = new Mouse3D({
	pressObj : canvas,
	passiveMove : updateMousePos,
	move : (dx,dy) => {
		updateMousePos();
		if (inputMethod == 'pan') {
			glutil.view.pos[0] -= dx / canvas.height * 2 * glutil.view.fovY;
			glutil.view.pos[1] += dy / canvas.height * 2 * glutil.view.fovY;
			glutil.updateProjection();
		} else if (inputMethod == 'draw') {
			createDrop();
		}
	},
	zoom : (dz) => {
		glutil.view.fovY *= Math.exp(-.1 * dz / canvas.height);
		glutil.updateProjection();
	},
	mousedown : () => {
		if (inputMethod == 'draw') {
			updateMousePos();
			createDrop();
		}
	}
});

for (let size = 32; size <= maxsize; size<<=1) {
	let option = DOM('option', {
		text : size,
		value : size,
		appendTo : ids.gridsize,
	});
	if (size == res) option.setAttribute('selected', 'true');
}
ids.gridsize.addEventListener('change', e => {
	const params = new URLSearchParams(urlparams);
	params.set('size', ids.gridsize.value);
	location.href = location.origin + location.pathname + '?' + params.toString();
});

ids.reset.addEventListener('click', e => { reset(); });

// TODO here and conway-life-webgl a better way ...
let updateRadio = function() {
	for (let k in ids) {
		if (k.substr(0,11) == 'inputMethod') {
			ids[k].checked = ids[k].value == inputMethod;
		}
	}
};
ids.inputMethod_pan.addEventListener('click', e => { inputMethod = 'pan'; });
ids.inputMethod_draw.addEventListener('click', e => { inputMethod = 'draw'; });
ids.button_pan.addEventListener('click', e => { inputMethod = 'pan'; updateRadio(); });
ids.button_draw.addEventListener('click', e => { inputMethod = 'draw'; updateRadio(); });

onresize();
window.addEventListener('resize', onresize);
update();
