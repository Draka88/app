module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      // Menonaktifkan plugin ESLint saat build
      webpackConfig.plugins = webpackConfig.plugins.filter(
        (plugin) => plugin.constructor.name !== 'ESLintWebpackPlugin'
      );
      return webpackConfig;
    },
  },
};