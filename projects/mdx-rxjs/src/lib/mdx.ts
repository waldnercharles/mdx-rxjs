import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { MdxExpressionTransform, MdxValue, IMdxFilter } from './mdx-types';
import { IMdxQueryOptions } from './query/models/mdx-query-options';
import { IMdxDimensionQuery } from './query/models/mdx-dimension-query';
import { IMdxTableQuery } from './query/models/mdx-table-query';
import { MdxQuerySerializer } from './query/mdx-query-serializer';
import { IMdxHandler } from './request/handlers/mdx-handler';
import { IMdxMember } from './request/models/mdx-member';
import { IMdxResponse } from './request/models/mdx-response';
import { MdxMemberSet } from './api/mdx-member-set';
import { IMdxAttributeData } from './api/mdx-attribute-data';
import { IMdxChartConfig } from './api/chart/mdx-chart-config';
import { IMdxChartData } from './api/chart/mdx-chart-data';
import { IMdxChartSeriesGroup } from './api/chart/mdx-chart-series-group';
import { IMdxChart, MdxChart } from './api/chart/mdx-chart';
import { IMdxDimensionRowResult } from './api/dimension/mdx-dimension-row-result';
import { IMdxDimensionRow } from './api/dimension/mdx-dimension-row';
import { IMdxTableRowData } from './api/table/mdx-table-row-data';
import { IMdxTableRowResult } from './api/table/mdx-table-row-result';
import { MdxVirtualRowBuilder, GetMdxVirtualRowCellDelegate } from './api/virtual-row/mdx-virtual-row-builder';
import { IMdxVirtualRowConfig } from './api/virtual-row/mdx-virtual-row-config';
import { IMdxVirtualRow } from './api/virtual-row/mdx-virtual-row';
import { MdxVirtualTableBuilder } from './api/virtual-row/mdx-virtual-table-builder';

export interface IDimensionQueryOptions extends Pick<IMdxDimensionQuery, Exclude<keyof IMdxDimensionQuery, 'attributes'>> {}

export class Mdx {
  private readonly mdxQuerySerializer: MdxQuerySerializer;

  constructor(cube: string, protected readonly handler: IMdxHandler) {
    this.mdxQuerySerializer = new MdxQuerySerializer(cube);
  }

  getChartData(config: IMdxChartConfig, options?: IMdxQueryOptions): Observable<IMdxChart> {
    const query: IMdxTableQuery = {
      ...options,
      measures: config.measures,
      rows: config.groupByLevelExpression ? [config.xAxisLevelExpression, config.groupByLevelExpression] : [config.xAxisLevelExpression]
    };

    const includeAll = (query.filters && query.filters.some(f => f.includeAllAggregation)) || false;
    const includeTotalCount = (query.filters && query.filters.some(f => f.includeInTotalCount)) || false;
    return this.postTableQuery(query).pipe(
      map(response => {
        const columnAxis = response.getColumnAxis();
        const columnTuples = columnAxis.tuples;
        const rowTuples = response.getRowAxis().tuples;
        const totalCountLevelExpression = includeTotalCount ? columnAxis.lastTuple().firstMember().levelExpression : null;

        const xAxis = new Set<NonNullable<MdxValue>>();
        let seriesNameSet = new Set<string>();
        const getSeriesName = (members: IMdxMember[]) => (members.length > 1 ? members[1].caption : null) || MdxMemberSet.Default;

        for (const rowTuple of rowTuples) {
          const currentXAxis = rowTuple.firstMember();
          xAxis.add(currentXAxis.value || '');

          const seriesName = getSeriesName(rowTuple.members);
          seriesNameSet.add(seriesName);
        }

        if (seriesNameSet.size === 0) {
          seriesNameSet.add(MdxMemberSet.Default);
          if (includeAll) {
            seriesNameSet.add(MdxMemberSet.All);
          }
        }

        const data: IMdxChartData = {};
        const measures: string[] = [];
        const seriesNames = Array.from(seriesNameSet.keys()).sort();
        for (const columnTuple of columnTuples) {
          const measure = columnTuple.firstMember();
          if (measure.levelExpression !== totalCountLevelExpression) {
            measures.push(measure.levelExpression);

            const seriesGroup: IMdxChartSeriesGroup = {};
            data[measure.levelExpression] = seriesGroup;

            for (const seriesName of seriesNames) {
              seriesGroup[seriesName] = [];
            }
          }
        }

        const addMeasureValues = (seriesName: string, nextValue: () => MdxValue) => {
          for (const measure of measures) {
            const seriesGroup = data[measure];
            if (!seriesGroup) {
              // This should never happen
              throw Error(`Invalid chart data. Measure ${measure} was defined but not initialized.`);
            }

            const series = seriesGroup[seriesName];
            if (!series) {
              // This should never happen
              throw Error(`Invalid chart series group. Series ${seriesName} was defined but not initialized.`);
            }

            series.push(nextValue() as number);
          }
        };

        let totalSeriesGroups: number | null = null;
        if (rowTuples.length > 0) {
          let dataIndex = 0;
          let previousXAxis: IMdxMember | null = null;

          for (const rowTuple of rowTuples) {
            const currentXAxis = rowTuple.firstMember();
            if (previousXAxis && currentXAxis.value !== previousXAxis.value) {
              seriesNameSet.forEach(sn => addMeasureValues(sn, () => null));
              seriesNameSet = new Set<string>(seriesNames);
            }

            const seriesName = getSeriesName(rowTuple.members);
            addMeasureValues(seriesName, () => response.getCellValue(dataIndex++));
            if (includeTotalCount) {
              totalSeriesGroups = response.getCellValue(dataIndex++) as number;
            }

            seriesNameSet.delete(seriesName);
            previousXAxis = currentXAxis;
          }

          seriesNameSet.forEach(sn => addMeasureValues(sn, () => null));
        }

        return new MdxChart(
          data,
          measures,
          seriesNames,
          Array.from(xAxis),
          seriesNameSet.has(MdxMemberSet.Default),
          seriesNameSet.has(MdxMemberSet.All),
          totalSeriesGroups
        );
      })
    );
  }

  getDimensionData(attributes: string[], options?: IDimensionQueryOptions): Observable<IMdxDimensionRowResult<IMdxAttributeData>> {
    const query: IMdxDimensionQuery = {
      ...options,
      attributes
    };

    const includeTotalCount = (query.filters && query.filters.some(f => f.includeInTotalCount)) || false;
    return this.postDimensionQuery(query).pipe(
      map(response => {
        const dataRows: IMdxDimensionRow<IMdxAttributeData>[] = [];
        let totalCount: MdxValue = null;

        const rowTuples = response.axes[1].tuples;
        if (rowTuples.length > 0) {
          const validCount = includeTotalCount ? rowTuples.length * 2 : rowTuples.length;
          if (validCount !== response.cellData.length) {
            const cellCount = response.cellData.length;
            throw Error(`Invalid request. The number of rows (${validCount}) must match the number of returned cells (${cellCount}).`);
          }

          let dataIndex = 0;
          for (const rowTuple of rowTuples) {
            const data = {} as IMdxAttributeData;
            for (const member of rowTuple.members) {
              data[member.levelExpression] = member.value;
            }

            dataRows.push({
              data,
              isNonEmpty: response.getCellValue(dataIndex++) === 1
            });

            if (includeTotalCount) {
              totalCount = response.getCellValue(dataIndex++);
            }
          }
        }

        const result: IMdxDimensionRowResult<IMdxAttributeData> = {
          rows: dataRows,
          totalCount: totalCount != null ? Number(totalCount) : null
        };

        return result;
      })
    );
  }

  getDimensionDtos<TDimensionData>(
    attributes: MdxExpressionTransform<TDimensionData>,
    options?: IDimensionQueryOptions
  ): Observable<IMdxDimensionRowResult<TDimensionData>> {
    const attributeMap = this.createExpressionMap(attributes);
    return this.getDimensionData(Array.from(attributeMap.keys()), options).pipe(
      map(dataResult => {
        const mapDataToDto = (r: IMdxDimensionRow<IMdxAttributeData>) => {
          const dtoData = {} as TDimensionData;
          for (const levelExpression in r.data) {
            if (r.data.hasOwnProperty(levelExpression)) {
              const propertyName = attributeMap.get(levelExpression);
              if (propertyName == null) {
                throw Error(`Invalid response. Level expression ${levelExpression} was provided but unexpected.`);
              }

              dtoData[propertyName] = r.data[levelExpression];
            }
          }

          const dtoRow: IMdxDimensionRow<TDimensionData> = {
            data: dtoData,
            isNonEmpty: r.isNonEmpty
          };

          return dtoRow;
        };

        const dtoResult: IMdxDimensionRowResult<TDimensionData> = {
          rows: dataResult.rows.map(mapDataToDto),
          totalCount: dataResult.totalCount
        };

        return dtoResult;
      })
    );
  }

  getTableRowData(measures: string[], rows: string[], options?: IMdxQueryOptions): Observable<IMdxTableRowResult<IMdxTableRowData>> {
    const query: IMdxTableQuery = {
      ...options,
      measures,
      rows
    };

    const includeAll = (query.filters && query.filters.some(f => f.includeAllAggregation)) || false;
    const includeTotalCount = (query.filters && query.filters.some(f => f.includeInTotalCount)) || false;
    return this.postTableQuery(query).pipe(
      map(response => {
        const columnAxis = response.getColumnAxis();
        const columnTuples = columnAxis.tuples;
        const rowTuples = response.getRowAxis().tuples;
        const totalCountLevelExpression = includeTotalCount ? columnAxis.lastTuple().firstMember().levelExpression : null;

        const dataRows: IMdxTableRowData[] = [];
        const totals: IMdxTableRowData[] = [];
        let totalCount: MdxValue = null;

        if (rowTuples.length === 0) {
          const emptyRow = {} as IMdxTableRowData;
          for (const columnTuple of columnTuples) {
            const measure = columnTuple.firstMember();
            if (measure.levelExpression !== totalCountLevelExpression) {
              emptyRow[measure.levelExpression] = 0;
            }
          }

          totals.push(emptyRow);
          totalCount = 0;
        } else {
          let dataIndex = 0;
          for (const rowTuple of rowTuples) {
            const dataRow = {} as IMdxTableRowData;
            for (const columnTuple of columnTuples) {
              const measure = columnTuple.firstMember();
              if (measure.levelExpression === totalCountLevelExpression) {
                totalCount = response.getCellValue(dataIndex++);
              } else {
                dataRow[measure.levelExpression] = response.getCellValue(dataIndex++);
              }
            }

            let levelNumber = Number.MAX_SAFE_INTEGER;
            for (const member of rowTuple.members) {
              levelNumber = Math.min(levelNumber, member.levelNumber);
              dataRow[member.levelExpression] = member.value;
            }

            if (levelNumber > 0) {
              dataRows.push(dataRow);
            } else {
              totals.push(dataRow);
            }
          }
        }

        if (totals.length > 1) {
          throw Error('Invalid response. Multiple totals were provided.');
        } else if (includeAll && totals.length !== 1) {
          throw Error('Invalid response. Totals were not provided, but expected.');
        } else if (!includeAll && totals.length === 1) {
          throw Error('Invalid response. Totals were provided, but unexpected.');
        }

        const result: IMdxTableRowResult<IMdxTableRowData> = {
          rows: dataRows,
          totals: includeAll ? totals[0] : null,
          totalCount: totalCount != null ? Number(totalCount) : null
        };

        return result;
      })
    );
  }

  getTableRowDtos<TRow extends object>(
    measuresAndRows: MdxExpressionTransform<TRow>,
    options?: IMdxQueryOptions
  ): Observable<IMdxTableRowResult<TRow>> {
    const levelExpressionMap = this.createExpressionMap(measuresAndRows);
    const measures: string[] = [];
    const rows: string[] = [];
    for (const levelExpression of Array.from(levelExpressionMap.keys())) {
      if (levelExpression.indexOf('[Measures]') === 0) {
        measures.push(levelExpression);
      } else {
        rows.push(levelExpression);
      }
    }

    return this.getTableRowData(measures, rows, options).pipe(
      map(dataResult => {
        const mapDataToDto = (r: IMdxTableRowData) => {
          const dtoRow = {} as TRow;
          for (const levelExpression in r) {
            if (r.hasOwnProperty(levelExpression)) {
              const propertyName = levelExpressionMap.get(levelExpression);
              if (propertyName == null) {
                throw Error(`Invalid response. Level expression ${levelExpression} was provided but unexpected.`);
              }

              dtoRow[propertyName] = r[levelExpression];
            }
          }

          return dtoRow;
        };

        const dtoResult: IMdxTableRowResult<TRow> = {
          rows: dataResult.rows.map(mapDataToDto),
          totals: dataResult.totals ? mapDataToDto(dataResult.totals) : null,
          totalCount: dataResult.totalCount
        };

        return dtoResult;
      })
    );
  }

  getVirtualTableBuilder<TRowCell, TExtendedProperties = any>(): MdxVirtualTableBuilder<TRowCell, TExtendedProperties> {
    return new MdxVirtualTableBuilder<TRowCell, TExtendedProperties>((config, filters) => this.getVirtualRows(config, filters));
  }

  private getVirtualRows<TRowCell, TExtendedProperties = any>(
    config: IMdxVirtualRowConfig<TRowCell, TExtendedProperties>,
    filters?: IMdxFilter[]
  ): Observable<IMdxVirtualRow<TRowCell, TExtendedProperties>[]> {
    const query: IMdxTableQuery = {
      measures: config.measures,
      filters
    };

    return this.postTableQuery(query).pipe(
      map(response => {
        const columnTuples = response.getColumnAxis().tuples;
        if (columnTuples.length !== response.cellData.length) {
          const columnCount = columnTuples.length;
          const cellCount = response.cellData.length;
          throw Error(`Invalid request. The number of columns (${columnCount}) must match the number of returned cells (${cellCount}).`);
        }

        if (columnTuples.length !== config.measures.length) {
          const columnCount = columnTuples.length;
          const measureCount = config.measures.length;
          throw Error(
            `Invalid request. The number of columns (${columnCount}) must match the number of requested measures (${measureCount}).`
          );
        }

        const rows: IMdxVirtualRow<TRowCell, TExtendedProperties>[] = [];
        if (columnTuples.length > 0) {
          let dataIndex = 0;
          for (const virtualRow of config.rows) {
            const cells: TRowCell[] = [];
            for (const virtualCell of virtualRow.cells) {
              if (typeof virtualCell !== 'function') {
                cells.push(virtualCell);
              } else {
                const data = response.getCell(dataIndex);
                const measure = columnTuples[dataIndex++].firstMember();
                cells.push((virtualCell as GetMdxVirtualRowCellDelegate<TRowCell>)(data, measure));
              }
            }

            rows.push({ cells, extendedProperties: virtualRow.extendedProperties });
          }
        }

        return rows;
      })
    );
  }

  private createExpressionMap<TData>(expressions: MdxExpressionTransform<TData>): Map<string, string> {
    const expressionMap = new Map<string, string>();
    for (const propertyName in expressions) {
      if (expressions.hasOwnProperty(propertyName)) {
        const expression = expressions[propertyName];
        if (typeof expression === 'string' && expression.startsWith('[') && expression.endsWith(']')) {
          if (expressionMap.has(expression)) {
            throw new Error(`Invalid expression ${expression} detected. It may not be defined more than once.`);
          }

          expressionMap.set(expression, propertyName);
        }
      }
    }

    return expressionMap;
  }

  private postDimensionQuery(query: IMdxDimensionQuery): Observable<IMdxResponse> {
    const mdxStatement = this.mdxQuerySerializer.serializeDimensionQuery(query);
    return this.handler.post(mdxStatement);
  }

  private postTableQuery(query: IMdxTableQuery): Observable<IMdxResponse> {
    const mdxStatement = this.mdxQuerySerializer.serializeTableQuery(query);
    return this.handler.post(mdxStatement);
  }
}
