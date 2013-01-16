var parser = require('./parser'),
	fs = require('fs'),
	EventEmitter = require('events').EventEmitter,
	blacklistedNames = { _name: 1, _value: 1, _remove: 1, _add: 1, _getString: 1, _root: 1, toString: 1 };

function createConfItem(file, context, name, value, children) {
	var newContext = {
		_remove: function(name, index) {
			index = Math.max(index || 0, 0);
			if (!this[name]) {
				return this;
			}

			var node = this[name];
			if (Array.isArray(this[name])) {
				if (this[name][index]) {
					node = this[name][index];
					this[name].splice(index, 1);
					if (this[name].length === 1) {
						this[name] = this[name][0];
					}
					file.emit('removed', node);
				}
			} else {
				node = this[name];
				delete this[name];
				file.emit('removed', node);
			}

			return this;
		},

		_add: function(name, value, children) {
			if (blacklistedNames[name]) {
				throw new Error('The name "' + name + '" is reserved');
			}

			var node = createConfItem(file, newContext, name, value, children);
			file.emit('added', node);
			return this;
		},

		_getString: function(depth) {
			depth = depth || +!this._root;
			var prefix = new Array(depth).join(file.tab),
				buffer = prefix + (!this._root ? this._name : ''),
				i;

			if (this._value) {
				buffer += ' ' + this._value;
			}

			var properties = Object.keys(this)
				.filter(function(key) {
					return typeof(newContext[key]) !== 'function';
				})
				.map(function(key) {
					return newContext[key];
				});

			if (properties.length) {
				if (!this._root) {
					buffer += ' {\n';
				}
				for (i = 0; i < properties.length; i++) {
					var prop = properties[i];
					if (Array.isArray(prop)) {
						for (var j = 0; j < prop.length; j++) {
							buffer += prop[j]._getString(depth + 1);
						}
					} else {
						buffer += prop._getString(depth + 1);
					}
				}
				if (!this._root) {
					buffer += prefix + '}\n';
				}
			} else if (!this._root) {
				buffer += ';\n';
			}

			return buffer;
		},

		toString: function() {
			return this._getString(0);
		}
	};

	Object.defineProperty(newContext, '_value', {
		enumerable: false,
		get: function() {
			return value;
		},
		set: function(newValue) {
			newValue = newValue.toString();
			if (value === newValue) {
				return;
			}

			var oldValue = value;
			value = newValue;
			file.emit('changed', newContext, oldValue);
		}
	});

	Object.defineProperty(newContext, '_name', {
		enumerable: false,
		value: name,
		writable: false
	});

	if (context[name]) {
		//already exists, create an array or append it to the new one
		if (!Array.isArray(context[name])) {
			context[name] = [ context[name] ];
		}

		context[name].push(newContext);
	} else {
		//console.log(require('util').inspect(context, false, null, true));
		context[name] = newContext;
	}

	if (children) {
		for (var i = 0; i < children.length; i++) {
			createConfItem(file, newContext, children[i].name, children[i].value, children[i].children);
		}
	}

	return newContext;
}

function NginxConfFile(tree, options) {
	options = options || {};
	this.files = [];
	this.tab = options.tab || '    ';
	this._name = 'NginxConfFile';
	this.liveListener = (function(file) {
		return function() {
			file.flush();
		};
	}(this));

	createConfItem(this, this, 'nginx');
	Object.defineProperty(this.nginx, '_root', {
		writable: false,
		value: true,
		enumerable: false
	});
	for (var i = 0; i < tree.children.length; i++) {
		var node = tree.children[i];
		createConfItem(this, this.nginx, node.name, node.value, node.children);
	}
}

NginxConfFile.prototype.__proto__ = EventEmitter.prototype;

NginxConfFile.prototype.live = function(file) {
	if (this.files.indexOf(file) === -1) {
		this.files.push(file);
		if (this.files.length === 1) {
			this.on('changed', this.liveListener);
		}
	}

	return this;
};

NginxConfFile.prototype.die = function(file) {
	var index = this.files.indexOf(file);
	if (index !== -1) {
		this.files.splice(index, 1);
		if (this.files.length == 0) {
			this.removeListener('added removed changed', this.liveListener);
		}
	}

	return this;
};

NginxConfFile.prototype.flush = function(callback) {
	var contents = this.toString(),
		errors = [],
		complete = 0,
		len = this.files.length,
		confFile = this;

	if (!len) {
		callback && callback();
		return;
	}

	for (var i = 0; i < len; i++) {
		fs.writeFile(this.files[i], contents, 'utf8', function(err) {
			err && errors.push(err);
			complete++;
			if (complete === len) {
				confFile.emit('flushed');
				callback && callback(errors.length ? errors : null);
			}
		});
	}
};

NginxConfFile.prototype.toString = function() {
	return this.nginx.toString();
};

NginxConfFile.create = function(file, options, callback) {
	if (typeof(options) === 'function') {
		callback = options;
		options = null;
	}

	parser.parseFile(file, 'utf8', function(err, tree) {
		if (err) {
			callback && callback(err);
			return;
		}

		callback && callback(null, new NginxConfFile(tree, options).live(file));
	});
};

NginxConfFile.createFromSource = function(source, options, callback) {
	if (typeof(options) === 'function') {
		callback = options;
		options = null;
	}

	parser.parse(source, function(err, tree) {
		if (err) {
			callback && callback(err);
			return;
		}

		callback && callback(null, new NginxConfFile(tree, options));
	});
};

exports.NginxConfFile = NginxConfFile;