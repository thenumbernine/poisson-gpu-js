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
var tmpTex;
var tmpTex2;
//shaders
var renderShaders = {};
var addDropShader;
var relaxShader;
var reduceShader;
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


function update() {
	var canvas = glutil.canvas;
	gl.viewport(0, 0, canvas.width, canvas.height);

	//just clears the buffer.  no scenegraph to draw
	glutil.draw();	

	//display
	glutil.unitQuad.draw({
		shader : renderShaders[currentDrawMode.name],
		uniforms : {
			lastMin : lastDataMin,
			lastMax : lastDataMax
		},
		texs : [
			potentialTex,
			densityTex,
			heatTex
		]
	});

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
	tmpTex = new glutil.FloatTexture2D({width:res, height:res});
	tmpTex2 = new glutil.FloatTexture2D({width:res, height:res});

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
return atan(dphi_d.y, dphi_d.x) / (2. * pi);
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
		
		renderShaders[drawMode.name] = new glutil.ShaderProgram({
			vertexPrecision : 'best',
			vertexCode : mlstr(function(){/*
attribute vec2 vertex;
varying vec2 pos;
uniform mat4 mvMat;
uniform mat4 projMat;
void main() {
	pos = vertex;
	gl_Position = projMat * mvMat * vec4(vertex.xy, 0., 1.);	//close to KernelShader, except has mvMat and projMat
}
*/}),
			fragmentPrecision : 'best',
			fragmentCode : 
'#extension GL_OES_standard_derivatives : enable\n'+
'const float dx = '+(1/res)+';\n'+
mlstr(function(){/*
varying vec2 pos;
uniform float lastMin, lastMax;
uniform sampler2D potentialTex;
uniform sampler2D densityTex;
uniform sampler2D heatTex;

float calcValue() {
*/}) + drawMode.code + mlstr(function(){/*
}

void main() {
	float v = calcValue();
	v = (v - lastMin) / (lastMax - lastMin);
	gl_FragColor = texture2D(heatTex, vec2(v, .5));
}
			*/}),
			uniforms : {
				potentialTex : 0,
				densityTex : 1,
				heatTex : 2
			}
		});
	});

	//set defaults
	currentDrawMode = drawModes[drawModes.findWithComparator(null, function(obj) { return obj.name == 'angle'; })];
	currentDrawMode.radio.prop('checked', true);

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

	addDropShader = new glutil.KernelShader({
		code : mlstr(function(){/*
void main() {
	vec2 delta = pos - point;
	float len = length(delta);
	float infl = step(-radius, -len);
	gl_FragColor = texture2D(tex, pos);
	gl_FragColor.r = mix(gl_FragColor.r, color, infl);
}
		*/}),
		uniforms : {
			color : ['float', .5],
			radius : ['float', .01],
			point : 'vec2'
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

	mouse = new Mouse3D({
		pressObj : canvas,
		move : function(dx, dy) {
			//add to density kernel  ...
			fbo.setColorAttachmentTex2D(0, tmpTex);
			fbo.draw({
				callback : function() {
					gl.viewport(0, 0, res, res);
					quadObj.draw({
						shader : addDropShader,
						texs : [densityTex],
						uniforms : {
							point : [
								(mouse.xf - .5) * glutil.canvas.width / glutil.canvas.height + .5,
								1 - mouse.yf
							]
						}
					});
				}
			});
			var tmp = tmpTex;
			tmpTex = densityTex;
			densityTex = tmp;
		}
	});

	onresize();
	$(window).resize(onresize);
	update();
});

