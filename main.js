/*
algorithm:
1) user draws into density buffer
2) jacobi relaxation of inverse discrete poisson to calculate potential buffer
3) min/max reduce across potential
4) heat map render
*/

var glutil;
var gl;

//fbo
var fbo;
//textures
var densityTex;
var potentialTex;
var displayTex;	//fbo renders whatever draw mode to this tex, then reduce finds the extents, then this is drawn with colors normalized
var reduceTex;	//scratch tex for finding the min/max
var tmpTex;
//shaders
var displayShaders = {};
var drawHeatShader;
var addDropShader;
var relaxShader;
var initReduceShader;
var reduceShader;
var encodeShaders = [];
//vars
var currentDrawMode;
var res = 1024;
var lastDataMin = 0;
var lastDataMax = 1;

//TODO make legit plugins out of these
//then replace the old Kernel with this (make sure nothing's using it)
//then remove the HydroGPU2DJS kernel and just use this
GLUtil.prototype.oninit.push(function() {
	var glutil = this;
	
	glutil.KernelShader = makeClass({
		super : glutil.ShaderProgram,
		init : function(args) {
			
			var varyingCodePrefix = 'varying vec2 pos;\n';

			var fragmentCodePrefix = '';
			var uniforms = {};
			if (args.uniforms !== undefined) {
				$.each(args.uniforms, function(uniformName, uniformType) {
					if ($.isArray(uniformType)) {
						//save initial value
						uniforms[uniformName] = uniformType[1];
						uniformType = uniformType[0];
					}
					fragmentCodePrefix += 'uniform '+uniformType+' '+uniformName+';\n';
				});
			}
			if (args.texs !== undefined) {
				for (var i = 0; i < args.texs.length; ++i) {
					var v = args.texs[i];
					var name, vartype;
					if (typeof(v) == 'string') {
						name = v;
						vartype = 'sampler2D';
					} else {
						name = v[0];
						vartype = v[1];
					}
					fragmentCodePrefix += 'uniform '+vartype+' '+name+';\n';
					uniforms[name] = i;
				}
			}


			if (!glutil.KernelShader.prototype.kernelVertexShader) {
				glutil.KernelShader.prototype.kernelVertexShader = new glutil.VertexShader({
					code : 
						glutil.vertexPrecision + 
						varyingCodePrefix +
						mlstr(function(){/*
attribute vec2 vertex;
attribute vec2 texCoord;
void main() {
	pos = texCoord; 
	gl_Position = vec4(vertex, 0., 1.);
}
*/})
				});	
			}

			args.vertexShader = glutil.KernelShader.prototype.kernelVertexShader;
			args.fragmentCode = glutil.fragmentPrecision + varyingCodePrefix + fragmentCodePrefix + args.code;
			delete args.code;
			args.uniforms = uniforms;	
			glutil.KernelShader.super.call(this, args);
		}
	});

	var FloatTexture2D = makeClass({
		super : glutil.Texture2D,
		init : function(args) {
			assertExists(args, 'width');
			assertExists(args, 'height');
			if (args.internalFormat === undefined) args.internalFormat = gl.RGBA;
			if (args.format === undefined) args.format = gl.RGBA;
			if (args.type === undefined) args.type = gl.FLOAT;
			if (args.minFilter === undefined) args.minFilter = gl.NEAREST;
			if (args.magFilter === undefined) args.magFilter = gl.NEAREST;
			if (args.wrap === undefined) args.wrap = {};
			if (args.wrap.s === undefined) args.wrap.s = gl.REPEAT;
			if (args.wrap.t === undefined) args.wrap.t = gl.REPEAT;
			FloatTexture2D.super.call(this, args);
		}
	});
	glutil.FloatTexture2D = FloatTexture2D;

});


function drawDisplayTex() {
	//display
	glutil.unitQuad.draw({
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
	fbo.setColorAttachmentTex2D(0, tmpTex);
	fbo.draw({
		callback : function() {
			gl.viewport(0, 0, res, res);
			quadObj.draw({
				shader : displayShaders[currentDrawMode.name],
				texs : [potentialTex, densityTex]
			});
		}
	});
	var tmp = tmpTex;
	tmpTex = displayTex;
	displayTex = tmp;
}

function relaxJacobiBuffer() {
	//relax buffer
	fbo.setColorAttachmentTex2D(0, tmpTex);
	fbo.draw({
		callback : function() {
			gl.viewport(0, 0, res, res);
			quadObj.draw({
				shader : relaxShader,
				texs : [potentialTex, densityTex]
			});
		}
	});
	var tmp = tmpTex;
	tmpTex = potentialTex;
	potentialTex = tmp;
}

function reduceDisplayTex() {
	//init reduceTex
	fbo.setColorAttachmentTex2D(0, tmpTex);
	fbo.draw({
		callback : function() {
			gl.viewport(0, 0, res, res);
			quadObj.draw({
				shader : initReduceShader,
				texs : [displayTex]
			});
		}
	});
	var tmp = tmpTex;
	tmpTex = reduceTex;
	reduceTex = tmp;

	//reduce to 1x1
	var size = res;
	while (size > 1) {
		size /= 2;
		if (size !== Math.floor(size)) throw 'got np2 size '+res;

		fbo.setColorAttachmentTex2D(0, tmpTex);
		fbo.draw({
			callback : function() {
				gl.viewport(0, 0, size, size);
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
		var tmp = tmpTex;
		tmpTex = reduceTex;
		reduceTex = tmp;
	}

	//extract the min/max from the last
	fbo.bind();
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmpTex.obj, 0);
	fbo.check();
	gl.viewport(0, 0, res, res);
	//TODO we don't need to draw to the whole quad if we're just going to read back the 1x1 corner pixel	
	var reduceUInt8Result = new Uint8Array(4);
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
	fbo.unbind();	
}

function update() {
	var canvas = glutil.canvas;
	gl.viewport(0, 0, canvas.width, canvas.height);

	//just clears the buffer.  no scenegraph to draw
	glutil.draw();	

	drawDisplayTex();	//draw old display tex to screen
	generateDisplayTex();	//generate new display tex
	relaxJacobiBuffer();	//relax density into potential
	reduceDisplayTex();		//reduce display tex to get min/max

	//update
	requestAnimFrame(update);
}

function onresize() {
	glutil.canvas.width = window.innerWidth;
	glutil.canvas.height = window.innerHeight;
	glutil.resize();
}

$(document).ready(function() {
	var canvas = $('<canvas>', {
		css : {
			left : 0,
			top : 0,
			position : 'absolute',
			background : 'red'
		}
	}).prependTo(document.body).get(0);

	$(canvas).disableSelection();

	try {
		glutil = new GLUtil({canvas:canvas});
		gl = glutil.context;
	} catch (e) {
		$('#menu').remove();
		$(canvas).remove();
		$('#webglfail').show();
		throw e;
	}


	glutil.view.ortho = true;
	glutil.view.zNear = -1;
	glutil.view.zFar = 1;
	glutil.view.fovY = .5;
	glutil.view.pos[0] = .5;
	glutil.view.pos[1] = .5;

	gl.clearColor(0,0,0,1);

	// heat map gradient texture
	
	heatTex = new glutil.GradientTexture({
		width : 256,
		colors : [
			[0, 0, 0],
			[0, 0, 1],
			[1, 1, 0],
			[1, 0, 0]
		],
		//dontRepeat : true
	});
	heatTex.bind();
	heatTex.setWrap({
		s : gl.REPEAT
	});
	heatTex.unbind();

	densityTex = new glutil.FloatTexture2D({width:res, height:res, data:function(){return[0,0,0,0];}});
	potentialTex = new glutil.FloatTexture2D({width:res, height:res, data:function(){return[0,0,0,0];}});
	displayTex = new glutil.FloatTexture2D({width:res, height:res, data:function(){return[0,0,0,0];}});
	reduceTex = new glutil.FloatTexture2D({width:res, height:res});
	tmpTex = new glutil.FloatTexture2D({width:res, height:res});

	// shaders

	//TODO generate radio inputs
	var drawModes = [
		{
			name : 'density',
			code : mlstr(function(){/*
return texture2D(densityTex, pos).r;
			*/})
		},
		{
			name : 'potential',
			code : mlstr(function(){/*
return texture2D(potentialTex, pos).r;
			*/})
		},
		{
			name : 'field',
			code : mlstr(function(){/*
float phiXP = texture2D(potentialTex, pos + vec2(dx, 0.)).r;
float phiXN = texture2D(potentialTex, pos - vec2(dx, 0.)).r;
float phiYP = texture2D(potentialTex, pos + vec2(0., dx)).r;
float phiYN = texture2D(potentialTex, pos - vec2(0., dx)).r;
vec2 dphi_d;
dphi_d.x = (phiXP - phiXN) / (2. * dx);
dphi_d.y = (phiYP - phiYN) / (2. * dx);
return length(dphi_d);
			*/})
		},
		{
			name : 'angle',
			code : mlstr(function(){/*
float phiXP = texture2D(potentialTex, pos + vec2(dx, 0.)).r;
float phiXN = texture2D(potentialTex, pos - vec2(dx, 0.)).r;
float phiYP = texture2D(potentialTex, pos + vec2(0., dx)).r;
float phiYN = texture2D(potentialTex, pos - vec2(0., dx)).r;
vec2 dphi_d;
dphi_d.x = (phiXP - phiXN) / (2. * dx);
dphi_d.y = (phiYP - phiYN) / (2. * dx);
const float pi = 3.141592653589793115997963468544185161590576171875;
return atan(dphi_d.y, dphi_d.x);
			*/})
		}
	];

	$.each(drawModes, function(_,drawMode) {
		drawMode.radio = $('<input>', {
			type : 'radio',
			name : 'drawMode',
			click : function() {
				currentDrawMode = drawMode;
			}
		}).appendTo($('#panel'));
		$('<span>', {text : drawMode.name}).appendTo($('#panel'));
		$('<br>').appendTo($('#panel'));
		
		displayShaders[drawMode.name] = new glutil.KernelShader({
			code : 
'#extension GL_OES_standard_derivatives : enable\n'+
'const float dx = '+(1/res)+';\n'+
mlstr(function(){/*
float calcValue() {
*/}) + drawMode.code + mlstr(function(){/*
}

void main() {
	float v = calcValue();
	gl_FragColor = vec4(v, 0., 0., 1.);
}
			*/}),
			texs : ['potentialTex', 'densityTex']
		});
	});

	//set defaults
	currentDrawMode = drawModes[drawModes.findWithComparator(null, function(obj) { return obj.name == 'angle'; })];
	currentDrawMode.radio.prop('checked', true);

	drawHeatShader = new glutil.ShaderProgram({
		vertexPrecision : 'best',
		vertexCode : mlstr(function(){/*
attribute vec2 vertex;
varying vec2 pos;
uniform mat4 mvMat;
uniform mat4 projMat;
void main() {
	pos = vertex;
	gl_Position = projMat * mvMat * vec4(vertex.xy, 0., 1.);
}
		*/}),
		fragmentPrecision : 'best',
		fragmentCode : mlstr(function(){/*
varying vec2 pos;
uniform sampler2D displayTex;
uniform sampler2D heatTex;
uniform float lastMin, lastMax;
void main() {
	float v = texture2D(displayTex, pos).r;
	v = (v - lastMin) / (lastMax - lastMin + 1e-6);
	gl_FragColor = texture2D(heatTex, vec2(v, .5));
}
		*/}),
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
	relaxShader = new glutil.KernelShader({
		code : 
'const float dx = '+(1/res)+';\n'+
mlstr(function(){/*
void main() {
	float rho = texture2D(densityTex, pos).r;
	float phi = texture2D(potentialTex, pos).r;
	float phiXP = texture2D(potentialTex, pos + vec2(dx, 0.)).r;
	float phiXN = texture2D(potentialTex, pos - vec2(dx, 0.)).r;
	float phiYP = texture2D(potentialTex, pos + vec2(0., dx)).r;
	float phiYN = texture2D(potentialTex, pos - vec2(0., dx)).r;
	const float pi = 3.141592653589793115997963468544185161590576171875;
	const float gravConst = 10000.;//1./(dx*dx);
	
	//TODO boundary conditions
	// if we're some sort of solid flag then don't update ... just fill in with the density
	
	float newPhi = (4. * pi * dx * dx * gravConst * rho - (phiXP + phiXN + phiYP + phiYN)) / -4.;
	gl_FragColor = vec4(newPhi, 0., 0., 1.);
}
		*/}),
		texs : ['potentialTex', 'densityTex']
	});

	//initReduce: map channel x to xy
	initReduceShader = new glutil.KernelShader({
		code : mlstr(function(){/*
void main() {
	gl_FragColor = texture2D(tex, pos).xxzw;
}
		*/}),
		texs : ['tex']
	});

	//reduce: reduce the mins of the x's and the maxs of the y's
	reduceShader = new glutil.KernelShader({
		code : mlstr(function(){/*
void main() {
	vec2 intPos = pos * viewsize - .5;

	//get four pixels to reduce to one ...
	//x holds the min, y holds the max
	vec2 a = texture2D(tex, (intPos * 2. + .5) / texsize).xy;
	vec2 b = texture2D(tex, (intPos * 2. + vec2(1., 0.) + .5) / texsize).xy;
	vec2 c = texture2D(tex, (intPos * 2. + vec2(0., 1.) + .5) / texsize).xy;
	vec2 d = texture2D(tex, (intPos * 2. + vec2(1., 1.) + .5) / texsize).xy;

	//final min
	float e = min(a.x, b.x);
	float f = min(c.x, d.x);
	float g = min(e, f);

	//final max
	float h = max(a.y, b.y);
	float i = max(c.y, d.y);
	float j = max(h, i);

	gl_FragColor = vec4(g, j, 0., 0.);

}
		*/}),
		uniforms : {
			texsize : 'vec2',
			viewsize : 'vec2'
		},
		texs : ['tex']
	});

	//http://lab.concord.org/experiments/webgl-gpgpu/webgl.html
	for (var channel = 0; channel < 4; ++channel) {
		encodeShaders[channel] = new glutil.KernelShader({
			code : mlstr(function(){/*
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

void main() {
	vec4 data = texture2D(tex, pos);
	gl_FragColor = encode_float(data[$channel]);
}
*/}).replace(/\$channel/g, channel),
			texs : ['tex']
		});
	}



	addDropShader = new glutil.KernelShader({
		code : mlstr(function(){/*
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
	
	
	float infl = step(-radius, -len);
	gl_FragColor = texture2D(tex, pos);
	gl_FragColor.r = mix(gl_FragColor.r, color, infl);
}
		*/}),
		uniforms : {
			color : ['float', .5],
			radius : ['float', 2/res],
			mousePos : 'vec2',
			mouseLastPos : 'vec2'
		},
		texs : ['tex']
	});

	fbo = new glutil.Framebuffer({
		width : res,	//shouldn't need size since there is no depth component
		height : res
	});

	//how does this compare with unitQuad?
	quadObj = new glutil.SceneObject({
		mode : gl.TRIANGLE_STRIP,
		attrs : {
			vertex : new glutil.ArrayBuffer({
				dim : 2,
				data : [-1,-1, 1,-1, -1,1, 1,1]
			}),
			texCoord : new glutil.ArrayBuffer({
				dim : 2,
				data : [0,0, 1,0, 0,1, 1,1]
			})
		},
		parent : null,
		static : true
	});

	var mousePos = vec2.create();
	var mouseLastPos = vec2.create();
	var mouse;
	var updateMousePos = function() {
		mouseLastPos[0] = mousePos[0];
		mouseLastPos[1] = mousePos[1];
		mousePos[0] = (mouse.xf - .5) * glutil.canvas.width / glutil.canvas.height + .5;
		mousePos[1] = 1 - mouse.yf;
	};
	var createDrop = function() {
		//add to density kernel  ...
		fbo.setColorAttachmentTex2D(0, tmpTex);
		fbo.draw({
			callback : function() {
				gl.viewport(0, 0, res, res);
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
		var tmp = tmpTex;
		tmpTex = densityTex;
		densityTex = tmp;
	};
	mouse = new Mouse3D({
		pressObj : canvas,
		passiveMove : updateMousePos,
		move : function() {
			updateMousePos();
			createDrop();
		},
		mousedown : function() {
			updateMousePos();
			createDrop();
		}
	});

	onresize();
	$(window).resize(onresize);
	update();
});

